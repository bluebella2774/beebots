import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { LIVE_ACK_PHRASE, loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { fundingHoursUtc, fundingPaymentUsd, fundingSlot, OKX_FUNDING_HOURS_UTC } from "../src/funding.js";
import { HyperliquidExecutor, type HlAccountInfo, type HlCreds, type HlExchangePort } from "../src/hl/executor.js";
import { belowMinNotional, formatHlPrice, formatHlSize, HL_MIN_ORDER_USD, iocLimitPrice, minSizeForNotional, toCloid } from "../src/hl/format.js";
import {
  fundingNow,
  indexMeta,
  instrumentsFromMeta,
  parseFees,
  parseFundingBills,
  parsePositions,
  type HlAssetCtx,
  type HlUniverseCoin,
} from "../src/hl/parse.js";
import { createHlPublicApi, type HlInfoMarket } from "../src/hl/public.js";
import { Jev } from "../src/jev.js";
import { gateUniverse } from "../src/market/universe.js";
import type { MarketFeed } from "../src/market/data.js";
import type { Instrument } from "../src/market/types.js";
import { finishDesign } from "../src/setup.js";
import { coin, NOW, position, testConfig, view } from "./fixtures.js";

const ACCT = `0x${"11".repeat(20)}` as const;
const AGENT = `0x${"ab".repeat(20)}` as const;
const KEY = `0x${"22".repeat(32)}` as const;

function hlDemoEnv(over: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { DRY_RUN: "false", MODE: "demo", EXCHANGE: "hyperliquid", GEMINI_API_KEY: "g", ...over };
  for (const b of ["BEE1", "BEE2", "BEE3"]) {
    env[`${b}_HL_TESTNET_ACCOUNT`] ??= ACCT;
    env[`${b}_HL_TESTNET_AGENT_KEY`] ??= KEY;
  }
  return env;
}

function ctx(over: Partial<HlAssetCtx> = {}): HlAssetCtx {
  return { prevDayPx: "100", dayNtlVlm: "1000000", markPx: "100", midPx: "100", funding: "0.0001", openInterest: "10", oraclePx: "100", ...over };
}

function coinMeta(name: string, szDecimals: number, maxLeverage = 50, isDelisted = false): HlUniverseCoin {
  return { name, szDecimals, maxLeverage, ...(isDelisted ? { isDelisted: true } : {}) };
}

describe("Hyperliquid price and size", () => {
  it("keeps 5 significant figures and at most 6 - szDecimals decimal places", () => {
    expect(formatHlPrice(1234.5, 0)).toBe("1234.5");
    expect(formatHlPrice(1234.56, 0)).toBe("1234.5");
    expect(formatHlPrice(0.001234, 0)).toBe("0.001234");
    expect(formatHlPrice(0.0012345, 0)).toBe("0.001234");
    expect(formatHlPrice(0.012345, 1)).toBe("0.01234");
    expect(formatHlPrice(0.0123456, 1)).toBe("0.01234");
    expect(formatHlPrice(123456, 0)).toBe("123456");
    expect(formatHlPrice(12345.6, 0)).toBe("12345");
    expect(formatHlPrice(97123.456789, 0)).toBe("97123");
    expect(formatHlPrice(1.23456789, 5)).toBe("1.2");
    expect(formatHlPrice(66086.421, 5)).toBe("66086");
    expect(formatHlPrice(0.0099, 0)).toBe("0.0099");
    expect(formatHlPrice(100000, 5)).toBe("100000");
  });

  it("truncates size to szDecimals", () => {
    expect(formatHlSize(1.23456789, 5)).toBe("1.23456");
    expect(formatHlSize(0.123456789, 2)).toBe("0.12");
    expect(formatHlSize(100, 0)).toBe("100");
  });

  it("rounds the $10 minimum up to the lot", () => {
    expect(HL_MIN_ORDER_USD).toBe(10);
    expect(minSizeForNotional(100000, 5)).toBeCloseTo(0.0001, 10);
    expect(minSizeForNotional(3, 2)).toBeCloseTo(3.34, 10);
    expect(belowMinNotional(0.00009, 100000)).toBe(true);
    expect(belowMinNotional(0.0001, 100000)).toBe(false);
  });

  it("builds an IOC limit inside the slippage cap and a 16-byte cloid", () => {
    expect(iocLimitPrice(100000, "buy", 100, 5)).toBe(formatHlPrice(101000, 5));
    expect(iocLimitPrice(100000, "sell", 100, 5)).toBe(formatHlPrice(99000, 5));
    const id = toCloid("bee1-1");
    expect(id).toMatch(/^0x[0-9a-f]{32}$/);
    expect(toCloid("bee1-1")).toBe(id);
  });
});

describe("funding cadence", () => {
  it("settles OKX three times a day and Hyperliquid every UTC hour", () => {
    expect([...fundingHoursUtc("okx")]).toEqual([0, 8, 16]);
    expect(fundingHoursUtc("hyperliquid")).toHaveLength(24);
    const day = Date.UTC(2026, 0, 2);
    const at = (h: number, m = 0) => day + h * 3_600_000 + m * 60_000;
    expect(fundingSlot(at(7, 59), OKX_FUNDING_HOURS_UTC)).toBe(at(0));
    expect(fundingSlot(at(8), OKX_FUNDING_HOURS_UTC)).toBe(at(8));
    expect(fundingSlot(at(7, 59), fundingHoursUtc("hyperliquid"))).toBe(at(7));
    expect(fundingSlot(at(8), fundingHoursUtc("hyperliquid"))).toBe(at(8));
    const hlSlots = new Set(Array.from({ length: 24 }, (_, h) => fundingSlot(at(h, 1), fundingHoursUtc("hyperliquid"))));
    const okxSlots = new Set(Array.from({ length: 24 }, (_, h) => fundingSlot(at(h, 1), fundingHoursUtc("okx"))));
    expect(hlSlots.size).toBe(24);
    expect(okxSlots.size).toBe(3);
  });

  it("charges a long the venue rate for that one settlement", () => {
    expect(fundingPaymentUsd("long", 0.0001, 100)).toBeCloseTo(-0.01, 10);
    expect(fundingPaymentUsd("short", 0.0001, 100)).toBeCloseTo(0.01, 10);
  });

  it("paper mode on Hyperliquid pays after one hour; OKX waits for the next 8h slot", async () => {
    const btc = coin("BTC", { fundingPct: 0.01 }, 100);
    const v = view([btc]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    async function run(exchange: "okx" | "hyperliquid", at: number) {
      let now = NOW;
      const cfg = testConfig(exchange === "hyperliquid" ? { EXCHANGE: "hyperliquid" } : {});
      const db = new Db(":memory:");
      const engine = new Engine({
        cfg,
        db,
        feed,
        jev: new Jev({ ...cfg.jev, client: { systemOne: async () => { throw new Error("not asked"); } } as never, now: () => now }),
        exec: new SimExecutor(() => v, cfg.risk.takerFeeRate),
        bus: new EventBus(db),
        alerts: new Alerts(undefined),
        now: () => now,
      });
      await engine.start();
      engine.stop();
      engine.bees.bee1.position = position(btc, { contracts: 100, side: "long" });
      now = at;
      await engine.tick();
      return engine.bees.bee1.totals.fundingUsd;
    }
    expect(await run("hyperliquid", NOW + 3_600_000)).toBeCloseTo(-0.01, 8);
    expect(await run("okx", NOW + 3_600_000)).toBe(0);
    expect(await run("okx", Date.UTC(2026, 8, 24, 16, 0, 0))).toBeCloseTo(-0.01, 8);
    expect(await run("hyperliquid", NOW + 30 * 60_000)).toBe(0);
  });
});

describe("position, fee and funding parsing", () => {
  it("keeps signed positions and drops flats", () => {
    expect(parsePositions([
      { position: { coin: "BTC", szi: "0.01", entryPx: "100" } },
      { position: { coin: "ETH", szi: "-2", entryPx: "50" } },
      { position: { coin: "SOL", szi: "0", entryPx: "1" } },
    ])).toEqual([
      { instId: "BTC", pos: 0.01, avgPx: 100 },
      { instId: "ETH", pos: -2, avgPx: 50 },
    ]);
  });

  it("sums USDC fees by order id and keeps a rebate negative", () => {
    const fees = parseFees([
      { oid: 7, fee: "0.02", feeToken: "USDC" },
      { oid: 7, fee: "0.01", feeToken: "USDC" },
      { oid: 7, fee: "-0.005", feeToken: "USDC" },
      { oid: 8, fee: "1", feeToken: "HYPE" },
      { oid: 9, fee: "0.5", feeToken: "USDC" },
    ], new Set(["7"]));
    expect(fees.get("7")).toBeCloseTo(0.025, 10);
    expect(fees.has("8")).toBe(false);
    expect(fees.has("9")).toBe(false);
  });

  it("reads funding USDC as a signed balance change", () => {
    expect(parseFundingBills([
      { time: 5, hash: "0xabc", delta: { coin: "BTC", usdc: "-1.5" } },
      { time: 6, hash: "0xabc", delta: { coin: "ETH", usdc: "0.25" } },
    ])).toEqual([
      { billId: "0xabc:BTC", instId: "BTC", amountUsd: -1.5, ts: 5 },
      { billId: "0xabc:ETH", instId: "ETH", amountUsd: 0.25, ts: 6 },
    ]);
  });
});

describe("public market data", () => {
  const universe: HlUniverseCoin[] = [
    coinMeta("OLD", 0, 10, true),
    coinMeta("BTC", 5, 40),
    coinMeta("xyz:TSLA", 2, 10),
    coinMeta("kPEPE", 0, 10),
    coinMeta("SOL", 2, 20),
  ];
  const ctxs: HlAssetCtx[] = [
    ctx({ dayNtlVlm: "1" }),
    ctx({ markPx: "100000", midPx: "100000", oraclePx: "100000", dayNtlVlm: "5000000000", funding: "0.0000125", openInterest: "2" }),
    ctx({ dayNtlVlm: "999999999" }),
    ctx({ markPx: "0.01", midPx: "0.01", oraclePx: "0.01", dayNtlVlm: "2000000000", funding: "0.0002" }),
    ctx({ markPx: "150", midPx: "150", dayNtlVlm: "1000000" }),
  ];

  function fakeInfo() {
    const calls: string[] = [];
    let metaHits = 0;
    const info: HlInfoMarket = {
      async metaAndAssetCtxs() {
        metaHits++;
        calls.push("meta");
        return [{ universe }, ctxs];
      },
      async l2Book(p) {
        calls.push(`book:${p.coin}`);
        if (p.coin === "SOL") return null;
        return { levels: [[{ px: "99" }], [{ px: "101" }]] };
      },
      async candleSnapshot(p) {
        calls.push(`candle:${p.coin}:${p.interval}:${p.startTime}`);
        return [{ t: 1_000, T: 2_000, o: "1", h: "2", l: "0.5", c: "1.5", v: "4" }];
      },
      async fundingHistory(p) {
        calls.push(`fund:${p.coin}:${p.startTime}`);
        return [{ fundingRate: "0.0001", time: p.startTime }];
      },
    };
    return { info, calls, metaHits: () => metaHits };
  }

  it("shares one meta snapshot, skips builder and delisted names, and keeps raw asset ids", async () => {
    const now = 1_700_000_000_000;
    const fake = fakeInfo();
    const api = createHlPublicApi({ info: fake.info, now: () => now, bookCoinLimit: 1, extraCoins: () => ["kPEPE"] });
    const instruments = await api.instruments();
    const tickers = await api.tickers();
    const oi = await api.openInterest();
    const funding = await api.funding("BTC");
    expect(fake.metaHits()).toBe(1);
    expect(instruments.map((i) => i.instId)).toEqual(["BTC", "kPEPE", "SOL"]);
    const kpepe = instruments.find((i) => i.coin === "kPEPE")!;
    expect(kpepe).toMatchObject({ kind: "crypto", venue: "hyperliquid", ctVal: 1, lotSz: 1, minSz: 1000 });
    expect(instruments.find((i) => i.coin === "BTC")).toMatchObject({ lotSz: 1e-5, minSz: 0.0001 });
    expect(api.assetIndex("BTC")).toBe(1);
    expect(api.assetIndex("kPEPE")).toBe(3);
    expect(api.assetIndex("OLD")).toBeUndefined();
    expect(indexMeta(universe, ctxs).find((r) => r.coin.name === "BTC")!.asset).toBe(1);
    expect([...tickers.keys()]).toEqual(["BTC", "kPEPE", "SOL"]);
    expect(tickers.get("SOL")!.spreadBp).toBe(Infinity);
    expect(tickers.get("BTC")!.spreadBp).toBeLessThan(Infinity);
    expect(fake.calls.filter((c) => c.startsWith("book:"))).toEqual(["book:BTC", "book:kPEPE"]);
    expect(oi.get("BTC")).toBeCloseTo(200000, 6);
    expect(funding.rate).toBeCloseTo(0.0000125, 10);
    expect(funding.nextFundingTime).toBe(Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000);
    expect(fundingNow(undefined, now).nextFundingTime).toBe(funding.nextFundingTime);
  });

  it("asks for hourly candles and at most 500 funding points starting at startTime", async () => {
    const now = 1_700_000_000_000;
    const fake = fakeInfo();
    const api = createHlPublicApi({ info: fake.info, now: () => now, bookCoinLimit: 1 });
    const candles = await api.candles("BTC", "1H", 10);
    expect(candles[0]).toMatchObject({ c: 1.5, volUsd: 6, confirmed: true });
    expect(fake.calls.some((c) => c.startsWith("candle:BTC:1h:"))).toBe(true);
    await api.fundingHistory("ETH", 90);
    await api.fundingHistory("SOL", 800);
    expect(fake.calls).toContain(`fund:ETH:${now - 90 * 3_600_000}`);
    expect(fake.calls).toContain(`fund:SOL:${now - 500 * 3_600_000}`);
  });

  it("lets a Hyperliquid perp through the universe gate and still requires an OKX X-Perp id", () => {
    const rows = instrumentsFromMeta(indexMeta(universe, ctxs));
    const tickers = new Map(rows.map((i) => [i.instId, {
      instId: i.instId, last: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBp: 1, vol24hUsd: 5e9, open24h: 90, ts: 1,
    }]));
    const gate = { min24hVolUsd: 1, spreadGateBps: 10, allowNonCrypto: false };
    expect(gateUniverse(rows, tickers, gate).tradable).toEqual(expect.arrayContaining(["BTC", "kPEPE"]));
    const bare: Instrument = { instId: "BTC", coin: "BTC", kind: "crypto", ctVal: 1, lotSz: 1, minSz: 1, tickSz: 1, state: "live" };
    const okx: Instrument = { ...bare, instId: "BTC-USD_UM_XPERP-310404" };
    const builder: Instrument = { ...bare, instId: "xyz:TSLA", coin: "xyz:TSLA", venue: "hyperliquid" };
    const book = new Map([["BTC", tickers.get("BTC")!], ["BTC-USD_UM_XPERP-310404", { ...tickers.get("BTC")!, instId: "BTC-USD_UM_XPERP-310404" }], ["xyz:TSLA", { ...tickers.get("BTC")!, instId: "xyz:TSLA" }]]);
    const mixed = gateUniverse([bare, okx, builder], book, gate);
    expect(mixed.tradable).toEqual(["BTC-USD_UM_XPERP-310404"]);
    expect(finishDesign({ name: "Pep", tagline: "the meme", rules: "Trade the meme coin only please", coins: ["kpepe"], baseStyle: "boozy", look: "a green bee" }, ["BTC", "kPEPE"], "Hyperliquid").coins).toEqual(["kPEPE"]);
  });
});

describe("Hyperliquid executor", () => {
  const creds: Partial<Record<"bee1", HlCreds>> = { bee1: { account: ACCT, agentKey: KEY } };

  function harness(over: { maxLev?: number; mid?: number; fills?: Array<{ oid: number; fee: string; feeToken: string }>; agents?: Array<{ address: `0x${string}`; name: string; validUntil: number | null }>; mode?: string } = {}) {
    const orders: unknown[] = [];
    const leverage: unknown[] = [];
    const cancels: unknown[] = [];
    const ex: HlExchangePort = {
      async updateLeverage(args) {
        leverage.push(args);
      },
      async order(args) {
        orders.push(args);
        return { response: { data: { statuses: [{ filled: { totalSz: "0.00005", avgPx: "100000", oid: 42 } }] } } };
      },
      async cancelByCloid(args) {
        cancels.push(args);
      },
    };
    const info: HlAccountInfo = {
      async clearinghouseState() {
        return { assetPositions: [] };
      },
      async userFunding() {
        return [];
      },
      async userFillsByTime() {
        return over.fills ?? [];
      },
      async extraAgents() {
        return over.agents ?? [{ address: AGENT, name: "bee", validUntil: null }];
      },
      async userAbstraction() {
        return over.mode ?? "default";
      },
    };
    const exec = new HyperliquidExecutor({
      creds,
      info,
      exchangeFor: () => ex,
      agentAddress: () => AGENT,
      meta: {
        refresh: async () => {},
        assetIndex: (id) => (id === "BTC" ? 1 : undefined),
        szDecimals: (id) => (id === "BTC" ? 5 : undefined),
        maxLeverage: () => over.maxLev ?? 40,
        mid: () => over.mid ?? 100_000,
      },
      leverage: 2,
      slippageBps: 100,
      takerFeeRate: 0.00045,
      now: () => 1_000_000,
    });
    return { exec, orders, leverage, cancels, ex };
  }

  it("sets isolated leverage once before an open, and not on a reduce-only close", async () => {
    const h = harness();
    const open = await h.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-1" });
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.contracts).toBeCloseTo(0.00005, 10);
    expect(h.leverage).toEqual([{ asset: 1, isCross: false, leverage: 2 }]);
    const sent = h.orders[0] as { orders: Array<{ a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: string } }; c: string }> };
    expect(sent.orders[0]).toMatchObject({ a: 1, b: true, p: iocLimitPrice(100000, "buy", 100, 5), s: "0.0002", r: false, t: { limit: { tif: "Ioc" } } });
    expect(sent.orders[0]!.c).toBe(toCloid("bee1-1"));
    await h.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-2" });
    expect(h.leverage).toHaveLength(1);
    const close = harness();
    const reduced = await close.exec.market("bee1", { instId: "BTC", side: "sell", contracts: 0.00005, reduceOnly: true, clOrdId: "bee1-3" });
    expect(reduced.ok).toBe(true);
    expect(close.leverage).toEqual([]);
  });

  it("rejects an opening order under $10 and still sends a reduce-only dust close", async () => {
    const h = harness();
    const small = await h.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.00005, reduceOnly: false, clOrdId: "bee1-small" });
    expect(small).toMatchObject({ ok: false, state: "rejected", error: { code: "MIN_NOTIONAL" } });
    expect(h.orders).toHaveLength(0);
    const dust = await h.exec.market("bee1", { instId: "BTC", side: "sell", contracts: 0.00005, reduceOnly: true, clOrdId: "bee1-dust" });
    expect(dust.ok).toBe(true);
  });

  it("refuses to open when the coin's max leverage is below the 2x cap", async () => {
    const h = harness({ maxLev: 1 });
    const res = await h.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-lev" });
    expect(res).toMatchObject({ ok: false, state: "rejected", error: { code: "LEVERAGE" } });
    expect(h.orders).toHaveLength(0);
    expect(h.leverage).toHaveLength(0);
  });

  it("maps exchange refusals to rejected and anything else to unknown", async () => {
    const h = harness();
    const refused = new Error("order 0: MinTradeNtl");
    refused.name = "ApiRequestError";
    h.ex.order = async () => {
      throw refused;
    };
    expect(await h.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-rej" })).toMatchObject({ ok: false, state: "rejected" });
    h.ex.order = async () => {
      throw new Error("socket hang up");
    };
    expect(await h.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-unk" })).toMatchObject({ ok: false, state: "unknown" });
  });

  it("cancels a resting IOC and reports it unfilled", async () => {
    const h = harness();
    h.ex.order = async () => ({ response: { data: { statuses: [{ resting: { oid: 7 } }] } } });
    const res = await h.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-rest" });
    expect(res).toMatchObject({ ok: false, state: "rejected" });
    expect(h.cancels).toEqual([{ cancels: [{ asset: 1, cloid: toCloid("bee1-rest") }] }]);
  });

  it("uses the fill fee when it is back, otherwise the taker estimate", async () => {
    const withFee = harness({ fills: [{ oid: 42, fee: "0.01", feeToken: "USDC" }] });
    const paid = await withFee.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-fee" });
    if (!paid.ok) throw new Error("expected a fill");
    expect(paid.feeUsd).toBeCloseTo(0.01, 10);
    const estimated = harness();
    const guess = await estimated.exec.market("bee1", { instId: "BTC", side: "buy", contracts: 0.0002, reduceOnly: false, clOrdId: "bee1-est" });
    if (!guess.ok) throw new Error("expected a fill");
    expect(guess.feeUsd).toBeCloseTo(0.00005 * 100000 * 0.00045, 10);
  });

  it("refuses a missing, expired, or non-standard API wallet before any order", async () => {
    const none = harness();
    const missing = new HyperliquidExecutor({
      creds: {},
      info: {
        clearinghouseState: async () => ({ assetPositions: [] }),
        userFunding: async () => [],
        userFillsByTime: async () => [],
        extraAgents: async () => [],
        userAbstraction: async () => "default",
      },
      exchangeFor: () => undefined,
      agentAddress: () => undefined,
      meta: {
        refresh: async () => {},
        assetIndex: () => 1,
        szDecimals: () => 5,
        maxLeverage: () => 40,
        mid: () => 100_000,
      },
      leverage: 2,
      slippageBps: 100,
      takerFeeRate: 0.00045,
    });
    await expect(missing.init("bee1")).rejects.toThrow(/no Hyperliquid API wallet/);
    await expect(harness({ agents: [] }).exec.init("bee1")).rejects.toThrow(/not approved/);
    await expect(harness({ agents: [{ address: AGENT, name: "bee", validUntil: 1 }] }).exec.init("bee1")).rejects.toThrow(/expired/);
    await expect(harness({ mode: "unifiedAccount" }).exec.init("bee1")).rejects.toThrow(/Standard/);
    await expect(none.exec.init("bee1")).resolves.toBeUndefined();
    await expect(harness({ mode: "disabled" }).exec.init("bee1")).resolves.toBeUndefined();
  });
});

describe("Hyperliquid config", () => {
  it("defaults to OKX and testnet, and keeps the 2x cap", () => {
    const dry = loadConfig({ GEMINI_API_KEY: "g" });
    expect(dry.exchange).toBe("okx");
    expect(dry.hl.network).toBe("testnet");
    expect(dry.hl.infoTestnet).toBe(false);
    expect(dry.hl.orderTestnet).toBe(true);
    expect(dry.risk.takerFeeRate).toBe(0.0005);
    expect(dry.risk.maxLeverage).toBe(2);
    expect(() => loadConfig({ EXCHANGE: "hyperliquid", MAX_LEVERAGE: "3" })).toThrow(/MAX_LEVERAGE/);
  });

  it("asks OKX demo for OKX keys and Hyperliquid demo for testnet wallets only", () => {
    expect(() => loadConfig({ DRY_RUN: "false", MODE: "demo" })).toThrow(/BEE1_OKX_DEMO_API_KEY/);
    const hl = loadConfig(hlDemoEnv());
    expect(hl.mode).toBe("demo");
    expect(hl.exchange).toBe("hyperliquid");
    expect(hl.hl).toMatchObject({ network: "testnet", infoTestnet: true, orderTestnet: true });
    expect(hl.creds.bee1).toBeUndefined();
    expect(hl.hlCreds.bee1?.account).toBe(ACCT);
    expect(hl.risk.takerFeeRate).toBeCloseTo(0.00045, 10);
    expect(loadConfig(hlDemoEnv({ TAKER_FEE_RATE: "0.0001" })).risk.takerFeeRate).toBeCloseTo(0.0001, 10);
  });

  it("refuses live Hyperliquid without the named mainnet opt-in, and refuses demo on mainnet", () => {
    const live: Record<string, string> = { DRY_RUN: "false", MODE: "live", EXCHANGE: "hyperliquid", LIVE_ACK: LIVE_ACK_PHRASE, GEMINI_API_KEY: "g" };
    for (const b of ["BEE1", "BEE2", "BEE3"]) {
      live[`${b}_HL_ACCOUNT`] = ACCT;
      live[`${b}_HL_AGENT_KEY`] = KEY;
    }
    let msg = "";
    try {
      loadConfig(live);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/HL_NETWORK/);
    expect(msg).not.toContain(KEY);
    expect(() => loadConfig(hlDemoEnv({ HL_NETWORK: "mainnet" }))).toThrow(/HL_NETWORK=testnet/);
    const on = loadConfig({ ...live, HL_NETWORK: "mainnet" });
    expect(on.hl).toMatchObject({ network: "mainnet", infoTestnet: false, orderTestnet: false });
    expect(loadConfig({ EXCHANGE: "hyperliquid", MODE: "live", HL_NETWORK: "mainnet", DRY_RUN: "true" }).mode).toBe("dry");
  });

  it("names a bad wallet variable and does not echo the value", () => {
    let msg = "";
    try {
      loadConfig(hlDemoEnv({ BEE1_HL_TESTNET_AGENT_KEY: "super-secret-key-value" }));
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("BEE1_HL_TESTNET_AGENT_KEY");
    expect(msg).not.toContain("super-secret-key-value");
  });
});
