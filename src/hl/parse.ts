import type { ExchangePosition, FundingBill } from "../exec/executor.js";
import { HL_MIN_ORDER_USD, lotStep, minSizeForNotional } from "./format.js";
import type { Candle, FundingNow, Instrument, Ticker } from "../market/types.js";

export interface HlUniverseCoin {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

/** Fields we read from metaAndAssetCtxs. The endpoint returns more; the rest is ignored. */
export interface HlAssetCtx {
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
  funding: string;
  openInterest: string;
  oraclePx: string;
}

export interface HlMetaRow {
  asset: number;
  coin: HlUniverseCoin;
  ctx: HlAssetCtx;
}

const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));

/** Main-dex perps only. Asset id is the index in the raw universe, including coins we skip. */
export function indexMeta(universe: HlUniverseCoin[], ctxs: HlAssetCtx[]): HlMetaRow[] {
  const rows: HlMetaRow[] = [];
  universe.forEach((coin, asset) => {
    const ctx = ctxs[asset];
    if (!ctx) return;
    rows.push({ asset, coin, ctx });
  });
  return rows;
}

export function tradableRow(row: HlMetaRow): boolean {
  return !row.coin.isDelisted && !row.coin.name.includes(":");
}

/**
 * Instrument ids are the Hyperliquid coin name (`BTC`, `kPEPE`). Size is in coins (ctVal = 1).
 * minSz is at least one lot and at least $10 notional at the current mark, which is what the risk layer already checks.
 * Builder markets (`xyz:TSLA`) and delisted names are left out.
 */
export function instrumentsFromMeta(rows: HlMetaRow[]): Instrument[] {
  const out: Instrument[] = [];
  for (const row of rows) {
    if (!tradableRow(row)) continue;
    const szDecimals = row.coin.szDecimals;
    const lot = lotStep(szDecimals);
    const mark = num(row.ctx.markPx);
    const minSz = mark > 0 ? Math.max(lot, minSizeForNotional(mark, szDecimals, HL_MIN_ORDER_USD)) : lot;
    out.push({
      instId: row.coin.name,
      coin: row.coin.name,
      kind: row.coin.name.startsWith("TEST") ? "test" : "crypto",
      ctVal: 1,
      lotSz: lot,
      minSz,
      tickSz: Number.NaN,
      state: "live",
      venue: "hyperliquid",
    });
  }
  return out;
}

export function tickerFromCtx(row: HlMetaRow, book: { bid: number; ask: number } | undefined, ts: number): Ticker {
  const mark = num(row.ctx.markPx);
  const midPx = num(row.ctx.midPx);
  const mid = midPx > 0 ? midPx : mark;
  const bid = book?.bid ?? Number.NaN;
  const ask = book?.ask ?? Number.NaN;
  const bookMid = bid > 0 && ask > 0 ? (bid + ask) / 2 : mid;
  return {
    instId: row.coin.name,
    last: mark,
    bid,
    ask,
    mid: bookMid > 0 ? bookMid : mid,
    spreadBp: bid > 0 && ask > 0 ? ((ask - bid) / bookMid) * 10_000 : Infinity,
    vol24hUsd: num(row.ctx.dayNtlVlm),
    open24h: num(row.ctx.prevDayPx),
    ts,
  };
}

export function openInterestUsd(row: HlMetaRow): number {
  const px = num(row.ctx.oraclePx);
  const mark = num(row.ctx.markPx);
  return num(row.ctx.openInterest) * (px > 0 ? px : mark);
}

/** `funding` on the asset context is the hourly rate. The next settlement is the next UTC hour. */
export function fundingNow(row: HlMetaRow | undefined, now: number): FundingNow {
  const hour = 3_600_000;
  return { rate: row ? num(row.ctx.funding) : Number.NaN, nextFundingTime: Math.floor(now / hour) * hour + hour };
}

const BAR_MS = { "15m": 15 * 60_000, "1H": 60 * 60_000, "4H": 4 * 60 * 60_000 } as const;
export const HL_BAR = { "15m": "15m", "1H": "1h", "4H": "4h" } as const;
export type HlBar = keyof typeof BAR_MS;

export function candleStart(now: number, bar: HlBar, limit: number): number {
  return Math.max(0, now - limit * BAR_MS[bar]);
}

export interface HlCandleRow {
  t: number;
  T: number;
  o: string;
  h: string;
  l: string;
  c: string;
  /** Base-coin volume. USD volume is v × close. */
  v: string;
}

export function parseCandles(rows: HlCandleRow[], now: number): Candle[] {
  return rows
    .map((r) => {
      const c = num(r.c);
      return { ts: r.t, o: num(r.o), h: num(r.h), l: num(r.l), c, volUsd: num(r.v) * c, confirmed: r.T <= now };
    })
    .sort((a, b) => a.ts - b.ts);
}

export function parsePositions(assetPositions: Array<{ position: { coin: string; szi: string; entryPx: string | null } }>): ExchangePosition[] {
  const out: ExchangePosition[] = [];
  for (const row of assetPositions) {
    const pos = num(row.position.szi);
    if (!Number.isFinite(pos) || pos === 0) continue;
    const avgPx = num(row.position.entryPx);
    out.push({ instId: row.position.coin, pos, avgPx: Number.isFinite(avgPx) ? avgPx : 0 });
  }
  return out;
}

/**
 * `delta.usdc` is the signed USDC balance change on the funding ledger (positive = received), same direction as OKX `balChg`.
 * Confirm the sign on testnet before trusting a live funding total.
 */
export function parseFundingBills(rows: Array<{ time: number; hash: string; delta: { coin: string; usdc: string } }>): FundingBill[] {
  const out: FundingBill[] = [];
  for (const r of rows) {
    const amountUsd = num(r.delta.usdc);
    if (!Number.isFinite(amountUsd)) continue;
    out.push({ billId: `${r.hash}:${r.delta.coin}`, instId: r.delta.coin, amountUsd, ts: r.time });
  }
  return out;
}

/**
 * Fill `fee` is positive when paid and negative for a rebate (SDK: "negative indicates rebate").
 * Only USDC fees count toward the USD books. Fills have no cloid, so they match on oid.
 */
export function parseFees(fills: Array<{ oid: number; fee: string; feeToken: string }>, ordIds: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of fills) {
    const id = String(f.oid);
    if (!ordIds.has(id) || f.feeToken !== "USDC") continue;
    const fee = num(f.fee);
    if (!Number.isFinite(fee)) continue;
    out.set(id, (out.get(id) ?? 0) + fee);
  }
  return out;
}
