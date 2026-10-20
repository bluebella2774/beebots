import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Alerts } from "./alerts.js";
import { BREEZY_COINS } from "./bees/breezy.js";
import { BEES, ConfigError, loadConfig, STYLES, type Config } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { EventBus } from "./events.js";
import { hashPassword, MIN_PASSWORD, PasswordGate } from "./gate.js";
import { Hive, hivePath } from "./hive.js";
import { HiveBoard, Keeper } from "./keeper.js";
import { KeeperHttp, keeperPath, KeeperSettings } from "./keeper-http.js";
import { effectiveCoins, liveRules } from "./lab/brain.js";
import { LAB_MIN_INTERVAL_MS, LabDoor } from "./lab/door.js";
import { LabStore } from "./lab/store.js";
import { OkxExecutor, SimExecutor, type Executor } from "./exec/executor.js";
import { HL_FUNDING_HISTORY_POINTS } from "./funding.js";
import { createHyperliquidRuntime } from "./hl/sdk.js";
import { Jev } from "./jev.js";
import { log, setLogLevel } from "./log.js";
import { MarketFeed } from "./market/data.js";
import { createOkxCli } from "./okx/cli.js";
import { createNewsSource } from "./okx/news.js";
import { createPublicApi } from "./okx/public.js";
import { createOkxPublicRest } from "./okx/rest.js";
import { safeError } from "./redact.js";
import { startServer } from "./server.js";
import { loadSettings, STYLE_INFO } from "./settings.js";
import { imagePath, Setup } from "./setup.js";
import { UpdateCheck } from "./update.js";
import { Visitors } from "./visitors.js";

const SETTINGS_PATH = process.env.SETTINGS_PATH?.trim() || "./data/settings.json";
// Reference portraits for generated bees: the dashboard's default art (copied into the image by the Dockerfile).
const REF_DIR = process.env.REF_DIR?.trim() || "./dashboard/public/bees";

/** Names, rules, styles and pictures for the dashboard. The rules and coins are the ones each bee trades on right now. */
function profile(cfg: Config | null, lab?: LabStore) {
  return {
    setup: cfg === null,
    mode: cfg?.mode ?? "dry",
    links: cfg?.links ?? null,
    bees: cfg
      ? BEES.map((id) => {
          const s = cfg.slots[id];
          const live = liveRules(s, lab?.overlay(id) ?? null);
          return {
            id,
            name: s.name,
            tagline: s.tagline,
            style: s.style,
            styleLabel: STYLE_INFO[s.style].label,
            rules: live.rules,
            coins: live.coins,
            // A Setup-made bee only ever shows its own portrait (null = the dashboard's placeholder mark), never the
            // original bees' art, which belongs to the three official bees.
            img: s.customImage && imagePath(cfg.settingsPath, id) ? `/bee-image/${id}` : s.fromSetup ? null : `/bees/${s.style}.jpg`,
          };
        })
      : [],
  };
}

/** No chooser key in the environment and no Setup file yet: serve only the Setup page until the owner fills it in. */
function runSetup() {
  const env = process.env;
  const setup = new Setup({
    settingsPath: SETTINGS_PATH,
    jevModel: env.JEV_MODEL?.trim() || "jev-1.13.0",
    geminiModel: env.GEMINI_MODEL?.trim() || "gemini-4-argon",
    openai: { apiKey: env.OPENAI_API_KEY?.trim() || undefined, textModel: env.OPENAI_TEXT_MODEL?.trim() || "gpt-5.4-nano", imageModel: env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2" },
    refDir: REF_DIR,
    windowMin: Math.max(1, Number(env.SETUP_WINDOW_MIN) || 120),
    okxApiBase: env.OKX_API_BASE?.trim().replace(/\/+$/, "") || "https://eea.okx.com",
    exchange: env.EXCHANGE?.trim() === "hyperliquid" ? "hyperliquid" : "okx",
    onSaved: () => {
      log.info("settings saved; exiting so Docker restarts the engine with them");
      process.exit(0);
    },
  });
  const port = Number(env.ENGINE_PORT) || 8080;
  startServer({ setup, profile: () => profile(null), beeImage: (b) => imagePath(SETTINGS_PATH, b) }, port, env.ENGINE_BIND?.trim() || "127.0.0.1");
  setup.announce();
}

async function main() {
  const settings = loadSettings(SETTINGS_PATH);
  if (!settings && !process.env.TYPESAFE_API_KEY?.trim() && !process.env.GEMINI_API_KEY?.trim()) return runSetup();
  let cfg;
  try {
    cfg = loadConfig({ ...process.env, SETTINGS_PATH }, settings);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("refusing to start", { reason: err.message });
      process.exit(1);
    }
    throw err;
  }
  setLogLevel(cfg.logLevel);
  log.info("beebots engine starting", { mode: cfg.mode, exchange: cfg.exchange, hlNetwork: cfg.exchange === "hyperliquid" ? cfg.hl.network : undefined, tickMs: cfg.tickMs, dataRefreshMs: cfg.dataRefreshMs, chooser: cfg.jev.provider, model: cfg.jev.model });

  const db = new Db(cfg.dbPath);
  const bus = new EventBus(db);
  const alerts = new Alerts(cfg.alertWebhookUrl);
  const demo = cfg.mode === "demo";
  const cli = cfg.exchange === "okx" ? createOkxCli({ site: cfg.okx.site, timeoutMs: cfg.okx.cliTimeoutMs }) : null;
  // Public market data runs in-process. OKX uses the kit's REST client. Hyperliquid uses one cached metaAndAssetCtxs.
  // Paper on Hyperliquid reads mainnet public prices and does not sign. Demo signs against testnet only.
  let engine: Engine | null = null;
  const held = () => (engine ? BEES.map((id) => engine!.bees[id]?.position?.instId).filter((x): x is string => !!x) : []);
  const hl = cfg.exchange === "hyperliquid" ? createHyperliquidRuntime({ infoTestnet: cfg.hl.infoTestnet, bookCoinLimit: cfg.hl.bookCoinLimit, extraCoins: () => ["BTC", "ETH", ...held().map((id) => id.split("-")[0]!)] }) : null;
  const api = hl ? hl.api : createPublicApi(cfg.okx.apiBase, demo, createOkxPublicRest({ apiBase: cfg.okx.apiBase, timeoutMs: cfg.okx.cliTimeoutMs }));
  // News needs a key: borrow the first Momentum bee's (OKX demo/live only). Hyperliquid has no news feed; boozy uses volume.
  const newsCreds = BEES.filter((b) => cfg.slots[b].style === "boozy").map((b) => cfg.creds[b]).find((c) => !!c);
  const news = cli && cfg.mode !== "dry" && newsCreds ? createNewsSource(cli, newsCreds, demo) : null;
  const feed = new MarketFeed(
    api,
    {
      min24hVolUsd: cfg.universe.min24hVolUsd,
      allowNonCrypto: cfg.universe.allowNonCrypto,
      spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)),
      trendCoins: [...BREEZY_COINS],
      fundingPoints: cfg.exchange === "hyperliquid" ? HL_FUNDING_HISTORY_POINTS : 90,
    },
    news,
    held,
  );

  const exec: Executor =
    cfg.mode === "dry"
      ? new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate)
      : hl
        ? hl.executor({ orderTestnet: cfg.hl.orderTestnet, creds: cfg.hlCreds, leverage: cfg.risk.maxLeverage, slippageBps: cfg.hl.slippageBps, takerFeeRate: cfg.risk.takerFeeRate })
        : new OkxExecutor(cli!, cfg.creds, demo, (id) => feed.view().instruments.get(id), cfg.risk.maxLeverage);

  const startOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  // Today's chooser spend survives a restart: the decisions' recorded cost, or the reservation ledger (which also holds
  // calls a restart cut off, at their worst case), whichever is higher.
  const jev = new Jev({ ...cfg.jev, spentTodayUsd: Math.max(db.jevSpendSince(startOfDay), db.chooserSpendSince(startOfDay)), ledger: db });

  // `deploy/close.sh` drops this file into the data volume to end the experiment cleanly (see Engine.windDown).
  const closeFlag = join(dirname(cfg.dbPath), `close-${cfg.mode}`);
  // Dry run only: `resume-last-dry` puts benched, flat bees back into their last position (consumed on use).
  const resumeFlag = join(dirname(cfg.dbPath), `resume-last-${cfg.mode}`);
  const takeResumeRequest = () => {
    if (cfg.mode !== "dry" || !existsSync(resumeFlag)) return false;
    unlinkSync(resumeFlag);
    return true;
  };
  // The Beekeeper's rewrites (rules text + coins per bee) live in the engine DB and apply on the next tick.
  const labStore = new LabStore(db);
  const live = (id: (typeof BEES)[number]) => liveRules(cfg.slots[id], labStore.overlay(id));
  // The Beekeeper (optional, docs/BEEKEEPER.md): a Zap that may rewrite one bee's rules. Connected from the dashboard.
  const keeperSettings = new KeeperSettings(keeperPath(cfg.settingsPath), cfg.keeper);
  const keeper = new Keeper({
    db,
    bus,
    config: () => keeperSettings.config,
    bee: (id) => {
      const s = cfg.slots[id];
      return { name: s.name, styleLabel: STYLE_INFO[s.style].label, ...live(id), ownerCoins: s.coins };
    },
    lockedUntil: (id) => {
      const last = labStore.lastChangeAt(id);
      return last === null ? null : last + LAB_MIN_INTERVAL_MS;
    },
    snapshot: () => engine!.snapshot(),
    board: new HiveBoard(cfg.hive.url),
    closed: () => existsSync(closeFlag),
  });
  // Setup was run again since a rewrite was made: the owner's new rules stand, the old rewrites are dropped.
  if (settings) {
    try {
      for (const id of labStore.dropBefore(settings.createdAt, "Setup was run again: the owner's new rules stand.", Date.now())) {
        log.info("beekeeper rewrite dropped: Setup was run again after it", { bee: id });
        keeper.rolledBack(id, "Setup was run again.", true);
      }
    } catch (err) {
      log.warn("could not drop the rewrites from before the last Setup", { err: safeError(err) });
    }
  }
  engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts, closeRequested: () => existsSync(closeFlag), takeResumeRequest, lab: labStore });
  await engine.start();

  // The owner password (picked on Setup) gates joining and leaving the Hive from the dashboard. Installs without one
  // (a Setup file from before it existed, or keys only in .env) can set OWNER_PASSWORD instead.
  const envPassword = process.env.OWNER_PASSWORD ?? "";
  if (envPassword && envPassword.length < MIN_PASSWORD) log.warn(`OWNER_PASSWORD is ignored: it needs at least ${MIN_PASSWORD} characters`);
  const ownerPasswordHash = settings?.ownerPasswordHash ?? (envPassword.length >= MIN_PASSWORD ? hashPassword(envPassword) : null);

  // One gate for every owner action on the dashboard (the Hive, the Beekeeper), so wrong passwords count once.
  const ownerGate = new PasswordGate("x-owner-password", () => ownerPasswordHash, "owner password");

  // The Hive (opt-in public leaderboard, paper only).
  const hive = new Hive({
    ownerPasswordHash: () => ownerPasswordHash,
    gate: ownerGate,
    path: hivePath(cfg.settingsPath),
    url: cfg.hive.url,
    mode: cfg.mode,
    db,
    portrait: (slot) => (cfg.slots[slot as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, slot) : null),
    source: () => {
      const snap = engine!.snapshot();
      return {
        startedAt: snap.startedAt,
        startEquityUsd: snap.startEquityUsd,
        bees: snap.bees.map((b) => {
          const s = cfg.slots[b.bee];
          // The rules the bee really trades on: the Beekeeper's while a rewrite is live, else the owner's.
          const { rules, coins } = live(b.bee);
          return { slot: b.bee, name: s.name, style: s.style, tagline: s.tagline, rules, coins, equityUsd: b.equityUsd, fundingUsd: b.totals.fundingUsd, cap: b.cap, tradesToday: b.tradesToday };
        }),
      };
    },
  });
  hive.start(settings);

  if (cfg.lab.secret && !LabDoor.enabled(cfg.lab.secret)) log.warn("LAB_SECRET is under 32 characters: it is ignored");
  const door = new LabDoor({
    store: labStore,
    secret: LabDoor.enabled(cfg.lab.secret) ? cfg.lab.secret : undefined,
    rounds: keeper,
    knownCoins: () => [...feed.view().instruments.values()].filter((i) => i.kind === "crypto" && i.state === "live").map((i) => i.coin),
    effectiveCoins: (id, coins) => effectiveCoins(cfg.slots[id].style, cfg.slots[id].coins, coins),
    notify: (text) => alerts.send(text),
  });
  // A bee sent home for the day or retired is worth a look now, not at the next scheduled round.
  bus.subscribe((_line, ev) => {
    // Off the engine's own call stack: the cap event fires in the middle of that bee's tick.
    if (ev.type === "cap" && (ev.cap === "loss_stop" || ev.cap === "retired")) setImmediate(() => keeper.onAlert(`${cfg.slots[ev.bee as (typeof BEES)[number]]?.name ?? "A bee"} (${String(ev.bee)}): ${String(ev.detail)}`));
  });
  const keeperTimer = setInterval(() => keeper.tick(), 15_000);
  log.info("beekeeper", { on: keeper.enabled, everyHours: keeper.everyHours(), rewritesLive: BEES.filter((b) => labStore.overlay(b) !== null).length });
  const keeperHttp = new KeeperHttp({ keeper, settings: keeperSettings, door, gate: ownerGate, name: (id) => cfg.slots[id].name });

  // "Update available" on the dashboard (checks GitHub Releases; never installs anything).
  const updates = new UpdateCheck({ repo: cfg.update.repo, current: cfg.update.version, enabled: cfg.update.enabled });
  updates.start();

  const server = startServer(
    {
      engine: { bus, db, visitors: new Visitors(db), snapshot: () => engine!.snapshot(), health: () => engine!.health(), update: () => updates.status() },
      hive,
      keeper: keeperHttp,
      lab: door,
      profile: () => profile(cfg, labStore),
      beeImage: (b) => (cfg.slots[b as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, b) : null),
    },
    cfg.server.port,
    cfg.server.bind,
  );

  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    engine?.stop();
    hive.stop();
    clearInterval(keeperTimer);
    updates.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: safeError(err) });
  process.exit(1);
});
