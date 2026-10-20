import type { PublicApi } from "../okx/public.js";
import { HL_FUNDING_HISTORY_POINTS } from "../funding.js";
import {
  candleStart,
  fundingNow,
  HL_BAR,
  indexMeta,
  instrumentsFromMeta,
  openInterestUsd,
  parseCandles,
  tickerFromCtx,
  tradableRow,
  type HlAssetCtx,
  type HlBar,
  type HlCandleRow,
  type HlMetaRow,
  type HlUniverseCoin,
} from "./parse.js";

export interface HlInfoMarket {
  metaAndAssetCtxs(): Promise<[{ universe: HlUniverseCoin[] }, HlAssetCtx[]]>;
  l2Book(params: { coin: string }): Promise<{ levels: [{ px: string }[], { px: string }[]] } | null>;
  candleSnapshot(params: { coin: string; interval: "15m" | "1h" | "4h"; startTime: number }): Promise<HlCandleRow[]>;
  fundingHistory(params: { coin: string; startTime: number }): Promise<Array<{ fundingRate: string; time: number }>>;
}

export interface HlMarketMeta {
  refresh(force?: boolean): Promise<void>;
  assetIndex(coin: string): number | undefined;
  szDecimals(coin: string): number | undefined;
  maxLeverage(coin: string): number | undefined;
  mid(coin: string): number | undefined;
}

export interface HlPublicApi extends PublicApi, HlMarketMeta {}

const META_TTL_MS = 8_000;
const BOOK_TTL_MS = 8_000;
const CANDLE_TTL_MS = 4 * 60_000;
const FUNDING_HIST_TTL_MS = 60 * 60_000;

/**
 * Public Hyperliquid market data. One cached `metaAndAssetCtxs` feeds instruments, mids, funding and open interest.
 * Best bid/ask come from `l2Book` for the busiest coins only (weight 2 each), not for every name.
 * Candles are cached for a few minutes: the 15m indicators do not need a fresh history every tick, and the mark comes from the mids.
 */
export function createHlPublicApi(opts: {
  info: HlInfoMarket;
  now?: () => number;
  bookCoinLimit?: number;
  extraCoins?: () => string[];
}): HlPublicApi {
  const now = opts.now ?? Date.now;
  const bookCoinLimit = opts.bookCoinLimit ?? 24;
  let rows: HlMetaRow[] | null = null;
  let rowsAt = 0;
  let inflight: Promise<HlMetaRow[]> | null = null;
  const index = new Map<string, { asset: number; szDecimals: number; maxLeverage: number }>();
  const books = new Map<string, { at: number; bid: number; ask: number }>();
  const candleCache = new Map<string, { at: number; rows: ReturnType<typeof parseCandles> }>();
  const fundingCache = new Map<string, { at: number; rates: number[] }>();

  const loadRows = async (force: boolean): Promise<HlMetaRow[]> => {
    const t = now();
    if (!force && rows && t - rowsAt < META_TTL_MS) return rows;
    if (!force && inflight) return inflight;
    const job = opts.info.metaAndAssetCtxs().then(([meta, ctxs]) => {
      const next = indexMeta(meta.universe, ctxs);
      index.clear();
      for (const row of next) {
        if (!tradableRow(row)) continue;
        index.set(row.coin.name, { asset: row.asset, szDecimals: row.coin.szDecimals, maxLeverage: row.coin.maxLeverage });
      }
      rows = next;
      rowsAt = now();
      return next;
    });
    inflight = job;
    try {
      return await job;
    } finally {
      if (inflight === job) inflight = null;
    }
  };

  const bookFor = async (names: string[]): Promise<Map<string, { bid: number; ask: number }>> => {
    const t = now();
    const out = new Map<string, { bid: number; ask: number }>();
    await Promise.all(
      names.map(async (coin) => {
        const hit = books.get(coin);
        if (hit && t - hit.at < BOOK_TTL_MS) {
          out.set(coin, hit);
          return;
        }
        const book = await opts.info.l2Book({ coin });
        const bid = Number(book?.levels?.[0]?.[0]?.px);
        const ask = Number(book?.levels?.[1]?.[0]?.px);
        if (bid > 0 && ask > 0) {
          const fresh = { at: now(), bid, ask };
          books.set(coin, fresh);
          out.set(coin, fresh);
        }
      }),
    );
    return out;
  };

  const coinsForBooks = (list: HlMetaRow[]): string[] => {
    const ranked = list
      .filter(tradableRow)
      .map((row) => ({ name: row.coin.name, vol: Number(row.ctx.dayNtlVlm) }))
      .sort((a, b) => b.vol - a.vol);
    const want = ranked.slice(0, bookCoinLimit).map((r) => r.name);
    const have = new Set(want);
    for (const coin of opts.extraCoins?.() ?? []) {
      if (!have.has(coin) && ranked.some((r) => r.name === coin)) want.push(coin);
    }
    return want;
  };

  return {
    async refresh(force = false) {
      await loadRows(force);
    },
    assetIndex: (coin) => index.get(coin)?.asset,
    szDecimals: (coin) => index.get(coin)?.szDecimals,
    maxLeverage: (coin) => index.get(coin)?.maxLeverage,
    mid(coin) {
      const row = rows?.find((r) => r.coin.name === coin);
      if (!row) return undefined;
      const mid = Number(row.ctx.midPx ?? row.ctx.markPx);
      return mid > 0 ? mid : undefined;
    },
    async instruments() {
      return instrumentsFromMeta(await loadRows(false));
    },
    async tickers() {
      const list = await loadRows(false);
      const got = await bookFor(coinsForBooks(list));
      const t = now();
      const out = new Map<string, ReturnType<typeof tickerFromCtx>>();
      for (const row of list) {
        if (!tradableRow(row)) continue;
        out.set(row.coin.name, tickerFromCtx(row, got.get(row.coin.name), t));
      }
      return out;
    },
    async candles(instId, bar, limit) {
      const key = `${instId}:${bar}:${limit}`;
      const t = now();
      const hit = candleCache.get(key);
      if (hit && t - hit.at < CANDLE_TTL_MS) return hit.rows;
      const raw = await opts.info.candleSnapshot({ coin: instId, interval: HL_BAR[bar as HlBar], startTime: candleStart(t, bar as HlBar, limit) });
      const parsed = parseCandles(raw, t).slice(-limit);
      candleCache.set(key, { at: t, rows: parsed });
      return parsed;
    },
    async openInterest() {
      const out = new Map<string, number>();
      for (const row of await loadRows(false)) {
        if (!tradableRow(row)) continue;
        out.set(row.coin.name, openInterestUsd(row));
      }
      return out;
    },
    async funding(instId) {
      const list = await loadRows(false);
      return fundingNow(list.find((r) => r.coin.name === instId), now());
    },
    async fundingHistory(instId, limit) {
      const t = now();
      const hit = fundingCache.get(instId);
      if (hit && t - hit.at < FUNDING_HIST_TTL_MS) return hit.rates.slice(-limit);
      const points = Math.min(limit, HL_FUNDING_HISTORY_POINTS);
      const raw = await opts.info.fundingHistory({ coin: instId, startTime: t - points * 3_600_000 });
      const rates = raw.map((r) => Number(r.fundingRate)).filter((n) => Number.isFinite(n));
      fundingCache.set(instId, { at: t, rates });
      return rates;
    },
  };
}
