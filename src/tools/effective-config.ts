// Effective config, secret-free. Loads an env file the way the engine container sees it (docker-compose.yml: env_file
// .env, then its `environment:` entries), plus your Setup file if you pass one, through the engine's own loadConfig, and
// prints every per-style knob, risk value and chooser setting as JSON. Secrets appear only as presence (true/false):
// never a value, a prefix, a length or any other hint. With --diff it lists every knob whose effective value differs
// from the intended one (strategies/ARGON_INTENDED.json = Gemini 4 Argon's rules).
//
//   pnpm effective-config .env [--settings data/settings.json] [--diff strategies/ARGON_INTENDED.json]
//   (the env file "-" means "no .env file")
//
// On a server running the published images (nothing is started, nothing is written; the .env is mounted read-only):
//   docker compose run --rm --no-deps --entrypoint node -v "$PWD/.env:/cfg/env:ro" engine \
//     dist/tools/effective-config.js /cfg/env --settings /data/settings.json --diff strategies/ARGON_INTENDED.json
//
// That file mode is a SIMULATION: it reads only the file you give it plus the compose defaults below, never process.env,
// so it cannot see settings that reach the container another way (Hostinger Docker Manager's environment variables,
// shell variables that docker compose substitutes, an edited compose file). Its output says "source": "file-simulation".
//
// To check what the RUNNING engine actually got, use --runtime inside its container. It reads this process's own
// environment (the container's, as compose built it) and the Setup file at SETTINGS_PATH, through the same loadConfig
// the engine runs. The output is the same allowlist: knob values, and keys as presence only. Never a value, never the
// environment itself. It says "source": "runtime".
//   docker compose exec engine node dist/tools/effective-config.js --runtime [--diff strategies/ARGON_INTENDED.json]
// (A running container keeps the environment it was started with: after changing settings, `docker compose up -d`
// first, then check.)
//
// Exit codes: 0 = printed (and no differences with --diff), 2 = differences found, 1 = config error or bad usage.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { BEES, ConfigError, loadConfig, STYLES } from "../config.js";
import { loadSettings, type Settings } from "../settings.js";

/**
 * docker-compose.yml `environment:` for the engine service. Fixed values always win; `${X:-default}` entries take the
 * env file's value when it is set, else the default. Keep in step with the compose file.
 */
export const COMPOSE_ENGINE_FIXED: Record<string, string> = { ENGINE_BIND: "0.0.0.0", ENGINE_PORT: "8080", DB_PATH: "/data/bees-{mode}.sqlite", SETTINGS_PATH: "/data/settings.json" };
export const COMPOSE_ENGINE_DEFAULTS: Record<string, string> = {
  DRY_RUN: "true",
  MODE: "dry",
  TICK_MS: "10000",
  JEV_DAILY_USD_CAP: "2",
  GEMINI_DAILY_USD_CAP: "3",
  BEE_START_EQUITY_USD: "333",
  UPDATE_CHECK: "true",
  HIVE_URL: "https://beebots.tech",
  EXCHANGE: "okx",
  HL_NETWORK: "testnet",
};

/** The env as the engine container sees it, from the env file alone. */
export function composeEnv(file: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...file };
  for (const [k, d] of Object.entries(COMPOSE_ENGINE_DEFAULTS)) if (!present(env[k])) env[k] = d;
  return { ...env, ...COMPOSE_ENGINE_FIXED };
}

/** Env names that set a knob explicitly (a value pinned in .env survives an update and beats the new code default). */
const KNOB_NAMES = [
  ...STYLES.flatMap((s) => ["MAX_TRADES_PER_DAY", "FEE_BUDGET_USD_DAY", "SPREAD_GATE_BPS", "COOLDOWN_MINUTES", "STOP_ATR_MULT", "MAX_FLAT_MINUTES"].map((k) => `${s.toUpperCase()}_${k}`)),
  "MAX_FLAT_MINUTES", "MAX_LEVERAGE", "MAX_NOTIONAL_USD_PER_BEE", "DAILY_LOSS_STOP_PCT", "BEE_RETIRE_AT_PCT", "LIVE_SIZE_MULTIPLIER", "LIVE_RAMP_HOURS",
  "BREEZY_MIN_OPEN_PROB", "BREEZY_MIN_SIZE_USD", "BIZZY_SIZE_FRACTION", "BIZZY_UNIVERSE_SIZE", "BIZZY_TIME_STOP_MINUTES", "BOOZY_CANDIDATES",
  "GEMINI_MODEL", "GEMINI_TIMEOUT_MS", "GEMINI_DAILY_USD_CAP", "GEMINI_USD_PER_MTOK", "GEMINI_USD_PER_MTOK_OUT", "GEMINI_MIN_INTERVAL_MS", "GEMINI_THINKING_LEVEL",
  "JEV_MODEL", "JEV_TIMEOUT_MS", "JEV_DAILY_USD_CAP", "JEV_USD_PER_MTOK",
  "TICK_MS", "DATA_REFRESH_MS", "MIN_24H_VOL_USD", "ALLOW_NON_CRYPTO", "TAKER_FEE_RATE", "BEE_START_EQUITY_USD",
];

const present = (v: string | undefined) => v !== undefined && v.trim() !== "";

/** The secret-free effective config for an env (already merged with the compose entries). Throws ConfigError. */
export function effectiveConfig(env: Record<string, string | undefined>, settings: Settings | null = null): Record<string, unknown> {
  const cfg = loadConfig(env, settings);
  return {
    mode: cfg.mode,
    exchange: cfg.exchange,
    hlNetwork: cfg.hl.network,
    tickMs: cfg.tickMs,
    dataRefreshMs: cfg.dataRefreshMs,
    slots: Object.fromEntries(BEES.map((b) => [b, cfg.slots[b].style])),
    bees: Object.fromEntries(STYLES.map((s) => [s, { ...cfg.bees[s] }])),
    risk: { ...cfg.risk },
    universe: { ...cfg.universe },
    breezy: { ...cfg.breezy },
    bizzy: { ...cfg.bizzy },
    boozy: { ...cfg.boozy },
    chooser: {
      provider: cfg.jev.provider,
      model: cfg.jev.model,
      timeoutMs: cfg.jev.timeoutMs,
      dailyUsdCap: cfg.jev.dailyUsdCap,
      usdPerMTokIn: cfg.jev.usdPerMTok,
      usdPerMTokOut: cfg.jev.usdPerMTokOut,
      minIntervalMs: cfg.jev.minIntervalMs,
      thinkingLevel: cfg.jev.thinkingLevel ?? null,
      apiKeyPresent: cfg.jev.apiKey !== "",
    },
    keys: {
      gemini: present(env.GEMINI_API_KEY) || !!settings?.geminiKey,
      jev: present(env.TYPESAFE_API_KEY) || !!settings?.jevKey,
      openai: !!cfg.openai.apiKey,
      ...Object.fromEntries(
        BEES.map((b) => {
          const p = b.toUpperCase();
          return [
            b,
            {
              okxLive: present(env[`${p}_OKX_API_KEY`]),
              okxDemo: present(env[`${p}_OKX_DEMO_API_KEY`]),
              hlTestnet: present(env[`${p}_HL_TESTNET_ACCOUNT`]) && present(env[`${p}_HL_TESTNET_AGENT_KEY`]),
              hlMainnet: present(env[`${p}_HL_ACCOUNT`]) && present(env[`${p}_HL_AGENT_KEY`]),
            },
          ];
        }),
      ),
    },
    keeper: { hookFromEnv: !!cfg.keeper.hookUrl, everyHours: cfg.keeper.everyHours ?? null },
    lab: { secretPresent: !!cfg.lab.secret },
    alerts: { webhookPresent: !!cfg.alertWebhookUrl },
    pinnedInEnv: KNOB_NAMES.filter((k) => present(env[k])),
  };
}

const flatten = (o: unknown, prefix = ""): Record<string, unknown> => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return { [prefix]: o };
  return Object.assign({}, ...Object.entries(o as Record<string, unknown>).filter(([k]) => !k.startsWith("_")).map(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k)));
};

/** Every intended knob (by dotted path) whose effective value differs, including ones missing from the effective config. */
export function diffConfig(effective: Record<string, unknown>, intended: Record<string, unknown>): Array<{ knob: string; effective: unknown; intended: unknown }> {
  const eff = flatten(effective);
  return Object.entries(flatten(intended))
    .filter(([k, v]) => JSON.stringify(eff[k] ?? null) !== JSON.stringify(v))
    .map(([knob, v]) => ({ knob, effective: eff[knob] ?? null, intended: v }));
}

/**
 * The secret-free effective config of THIS process's environment (inside the engine container: what the engine was
 * started with), plus the Setup file at SETTINGS_PATH when it exists. Same loadConfig and allowlist as the file mode.
 */
export function runtimeEffectiveConfig(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  // Same default as config.ts SETTINGS_PATH (the compose file sets /data/settings.json).
  const settingsPath = env.SETTINGS_PATH?.trim() || "./data/settings.json";
  const settings = existsSync(settingsPath) ? loadSettings(settingsPath) : null;
  return { source: "runtime", settingsFile: settings !== null, ...effectiveConfig(env, settings) };
}

function main(argv: string[]): number {
  const runtime = argv[0] === "--runtime";
  const file = runtime ? "--runtime" : argv[0];
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? "") : undefined;
  };
  const intendedPath = flag("--diff");
  const settingsPath = flag("--settings");
  if (!file || (!runtime && file.startsWith("-") && file !== "-") || (runtime && settingsPath !== undefined) || intendedPath === "" || settingsPath === "") {
    process.stderr.write(
      "usage: effective-config <env-file> [--settings <settings.json>] [--diff <intended.json>]   (simulation from a file)\n" +
        "       effective-config --runtime [--diff <intended.json>]   (inside the engine container: what it runs)\n",
    );
    return 1;
  }
  let eff: Record<string, unknown>;
  try {
    if (runtime) eff = runtimeEffectiveConfig(process.env);
    else {
      const env = composeEnv(file === "-" ? {} : parseEnv(readFileSync(file, "utf8")));
      const settings = settingsPath && existsSync(settingsPath) ? loadSettings(settingsPath) : null;
      eff = { source: "file-simulation", settingsFile: settings !== null, ...effectiveConfig(env, settings) };
    }
  } catch (err) {
    // ConfigError messages list variable NAMES only, never values.
    process.stderr.write(err instanceof ConfigError ? `${err.message}\n` : "config could not be loaded\n");
    return 1;
  }
  if (!intendedPath) {
    process.stdout.write(JSON.stringify(eff, null, 2) + "\n");
    return 0;
  }
  const diffs = diffConfig(eff, JSON.parse(readFileSync(intendedPath, "utf8")) as Record<string, unknown>);
  process.stdout.write(JSON.stringify({ effective: eff, differences: diffs }, null, 2) + "\n");
  return diffs.length ? 2 : 0;
}

if (process.argv[1] && /effective-config\.(ts|js)$/.test(process.argv[1])) process.exitCode = main(process.argv.slice(2));
