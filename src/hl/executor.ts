import type { BeeId } from "../config.js";
import type { ExchangePosition, Executor, FundingBill, OrderReq, OrderResult } from "../exec/executor.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import { belowMinNotional, formatHlSize, HL_MIN_ORDER_USD, iocLimitPrice, orderNotionalUsd, toCloid } from "./format.js";
import type { HlMarketMeta } from "./public.js";
import { parseFees, parseFundingBills, parsePositions } from "./parse.js";

export interface HlCreds {
  /** Master account. Info queries use this address, never the agent address. */
  account: `0x${string}`;
  /** API wallet private key. It can trade and cannot withdraw. */
  agentKey: `0x${string}`;
}

export interface HlOrderStatus {
  filled?: { totalSz: string; avgPx: string; oid: number };
  resting?: { oid: number };
  error?: string;
}

export interface HlExchangePort {
  updateLeverage(args: { asset: number; isCross: boolean; leverage: number }): Promise<void>;
  order(args: {
    orders: Array<{ a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: "Ioc" } }; c: `0x${string}` }>;
    grouping: "na";
  }): Promise<{ response: { data: { statuses: Array<HlOrderStatus | string> } } }>;
  cancelByCloid(args: { cancels: Array<{ asset: number; cloid: `0x${string}` }> }): Promise<void>;
}

export interface HlAccountInfo {
  clearinghouseState(args: { user: `0x${string}` }): Promise<{ assetPositions: Array<{ position: { coin: string; szi: string; entryPx: string | null } }> }>;
  userFunding(args: { user: `0x${string}`; startTime: number }): Promise<Array<{ time: number; hash: string; delta: { coin: string; usdc: string } }>>;
  userFillsByTime(args: { user: `0x${string}`; startTime: number }): Promise<Array<{ oid: number; fee: string; feeToken: string }>>;
  extraAgents(args: { user: `0x${string}` }): Promise<Array<{ address: `0x${string}`; name: string; validUntil: number | null }>>;
  userAbstraction(args: { user: `0x${string}` }): Promise<string>;
}

const STANDARD_MODES = new Set(["default", "disabled"]);

function failureState(err: unknown): "rejected" | "unknown" {
  const name = err instanceof Error ? err.name : "";
  // ValidationError never left the process. ApiRequestError is the exchange refusing the action.
  if (name === "ApiRequestError" || name === "ValidationError" || name === "FormatError") return "rejected";
  return "unknown";
}

/**
 * MODE=demo (testnet) / MODE=live (mainnet only when HL_NETWORK=mainnet).
 * There is no native market order: an IOC limit is sent through the book by the slippage cap.
 * Isolated leverage is set before an opening order. Queries use the master address.
 */
export class HyperliquidExecutor implements Executor {
  readonly kind = "hl" as const;
  private leverageSet = new Set<string>();
  private now: () => number;

  constructor(
    private opts: {
      creds: Partial<Record<BeeId, HlCreds>>;
      info: HlAccountInfo;
      exchangeFor(bee: BeeId): HlExchangePort | undefined;
      agentAddress(bee: BeeId): `0x${string}` | undefined;
      meta: HlMarketMeta;
      leverage: number;
      slippageBps: number;
      takerFeeRate: number;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  async init(bee: BeeId): Promise<void> {
    const c = this.opts.creds[bee];
    const agent = this.opts.agentAddress(bee);
    if (!c || !agent) throw new Error(`no Hyperliquid API wallet for ${bee}`);
    const agents = await this.opts.info.extraAgents({ user: c.account });
    const hit = agents.find((a) => a.address.toLowerCase() === agent.toLowerCase());
    if (!hit) throw new Error(`${bee}: Hyperliquid API wallet is not approved on this account`);
    if (hit.validUntil !== null && hit.validUntil <= this.now()) throw new Error(`${bee}: Hyperliquid API wallet has expired`);
    const mode = await this.opts.info.userAbstraction({ user: c.account });
    if (!STANDARD_MODES.has(mode)) {
      throw new Error(`${bee}: Hyperliquid account mode is ${mode}. Switch the bot account to Standard before trading.`);
    }
  }

  private async ensureLeverage(bee: BeeId, ex: HlExchangePort, asset: number, maxLev: number): Promise<string | null> {
    const key = `${bee}:${asset}`;
    if (this.leverageSet.has(key)) return null;
    const want = Math.floor(this.opts.leverage);
    if (want < 1) return "configured leverage is below 1";
    if (maxLev < want) return `coin max leverage is ${maxLev}, below the configured ${want}`;
    await ex.updateLeverage({ asset, isCross: false, leverage: want });
    this.leverageSet.add(key);
    return null;
  }

  async market(bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const ex = this.opts.exchangeFor(bee);
    if (!ex) return { ok: false, error: { code: "INST", message: "no Hyperliquid API wallet" }, state: "rejected" };
    try {
      await this.opts.meta.refresh(true);
      const asset = this.opts.meta.assetIndex(req.instId);
      const szd = this.opts.meta.szDecimals(req.instId);
      const maxLev = this.opts.meta.maxLeverage(req.instId);
      const mid = this.opts.meta.mid(req.instId);
      if (asset === undefined || szd === undefined || maxLev === undefined || !(mid && mid > 0)) {
        return { ok: false, error: { code: "INST", message: "unknown coin" }, state: "rejected" };
      }
      let sz: string;
      try {
        sz = formatHlSize(req.contracts, szd);
      } catch (err) {
        return { ok: false, error: { code: "SIZE", message: safeError(err).message }, state: "rejected" };
      }
      if (!req.reduceOnly && belowMinNotional(Number(sz), mid)) {
        return { ok: false, error: { code: "MIN_NOTIONAL", message: `order is under $${HL_MIN_ORDER_USD}` }, state: "rejected" };
      }
      if (!req.reduceOnly) {
        const why = await this.ensureLeverage(bee, ex, asset, maxLev);
        if (why) return { ok: false, error: { code: "LEVERAGE", message: why }, state: "rejected" };
      }
      const px = iocLimitPrice(mid, req.side, this.opts.slippageBps, szd);
      const cloid = toCloid(req.clOrdId);
      const res = await ex.order({
        orders: [{ a: asset, b: req.side === "buy", p: px, s: sz, r: req.reduceOnly, t: { limit: { tif: "Ioc" } }, c: cloid }],
        grouping: "na",
      });
      const st = res.response.data.statuses[0];
      if (st && typeof st === "object" && st.filled) {
        const contracts = Number(st.filled.totalSz);
        const avgPx = Number(st.filled.avgPx);
        const ordId = String(st.filled.oid);
        return { ok: true, ordId, contracts, avgPx, feeUsd: await this.feeFor(bee, ordId, contracts, avgPx), ts: this.now() };
      }
      if (st && typeof st === "object" && st.resting) {
        await ex.cancelByCloid({ cancels: [{ asset, cloid }] }).catch((err) => log.warn("IOC cancel failed", { bee, err: safeError(err) }));
        return { ok: false, error: { code: "IOC", message: "order was not filled" }, state: "rejected" };
      }
      const message = st && typeof st === "object" && st.error ? st.error : "order was not filled";
      return { ok: false, error: { code: "HL", message: message.slice(0, 240) }, state: "rejected" };
    } catch (err) {
      return { ok: false, error: safeError(err), state: failureState(err) };
    }
  }

  private async feeFor(bee: BeeId, ordId: string, contracts: number, avgPx: number): Promise<number> {
    const estimate = orderNotionalUsd(contracts, avgPx) * this.opts.takerFeeRate;
    const c = this.opts.creds[bee];
    if (!c) return estimate;
    try {
      const fills = await this.opts.info.userFillsByTime({ user: c.account, startTime: this.now() - 60_000 });
      const got = parseFees(fills, new Set([ordId])).get(ordId);
      return got === undefined ? estimate : got;
    } catch (err) {
      log.warn("fill fee read failed", { bee, err: safeError(err) });
      return estimate;
    }
  }

  async positions(bee: BeeId): Promise<ExchangePosition[] | null> {
    const c = this.opts.creds[bee];
    if (!c) return null;
    try {
      const state = await this.opts.info.clearinghouseState({ user: c.account });
      return parsePositions(state.assetPositions);
    } catch (err) {
      log.warn("positions read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async fundingBills(bee: BeeId): Promise<FundingBill[] | null> {
    const c = this.opts.creds[bee];
    if (!c) return null;
    try {
      const rows = await this.opts.info.userFunding({ user: c.account, startTime: this.now() - 7 * 86_400_000 });
      return parseFundingBills(rows);
    } catch (err) {
      log.warn("funding read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async feesFor(bee: BeeId, _instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null> {
    const c = this.opts.creds[bee];
    if (!c) return null;
    try {
      const fills = await this.opts.info.userFillsByTime({ user: c.account, startTime: this.now() - 7 * 86_400_000 });
      return parseFees(fills, ordIds);
    } catch (err) {
      log.warn("fills read failed", { bee, err: safeError(err) });
      return null;
    }
  }
}
