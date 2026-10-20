import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { BeeId } from "../config.js";
import { HyperliquidExecutor, type HlAccountInfo, type HlCreds, type HlExchangePort } from "./executor.js";
import { HL_WEIGHT, WeightBudget } from "./limit.js";
import { createHlPublicApi, type HlInfoMarket, type HlPublicApi } from "./public.js";

function gate<T>(budget: WeightBudget, weight: number, fn: () => Promise<T>): Promise<T> {
  return budget.take(weight).then(fn);
}

/** One info client, one IP weight budget. Market data and account reads share it. */
export function limitInfo(info: InfoClient, budget: WeightBudget): HlInfoMarket & HlAccountInfo {
  return {
    metaAndAssetCtxs: () => gate(budget, HL_WEIGHT.metaAndAssetCtxs, () => info.metaAndAssetCtxs()),
    l2Book: (p) => gate(budget, HL_WEIGHT.l2Book, () => info.l2Book(p)),
    candleSnapshot: (p) => gate(budget, HL_WEIGHT.candleSnapshot, () => info.candleSnapshot(p)),
    fundingHistory: (p) => gate(budget, HL_WEIGHT.fundingHistory, () => info.fundingHistory(p)),
    clearinghouseState: (p) => gate(budget, HL_WEIGHT.clearinghouseState, () => info.clearinghouseState(p)),
    userFunding: (p) => gate(budget, HL_WEIGHT.userFunding, () => info.userFunding(p)),
    userFillsByTime: (p) => gate(budget, HL_WEIGHT.userFillsByTime, () => info.userFillsByTime(p)),
    extraAgents: (p) => gate(budget, HL_WEIGHT.extraAgents, () => info.extraAgents(p)),
    userAbstraction: (p) => gate(budget, HL_WEIGHT.userAbstraction, () => info.userAbstraction(p)),
  };
}

function exchangePort(client: ExchangeClient): HlExchangePort {
  return {
    updateLeverage: (args) => client.updateLeverage(args).then(() => undefined),
    order: (args) => client.order(args),
    cancelByCloid: (args) => client.cancelByCloid(args).then(() => undefined),
  };
}

export interface HlRuntime {
  api: HlPublicApi;
  executor(args: { orderTestnet: boolean; creds: Partial<Record<BeeId, HlCreds>>; leverage: number; slippageBps: number; takerFeeRate: number }): HyperliquidExecutor;
}

/**
 * `infoTestnet` selects the public API (paper uses mainnet prices; demo uses testnet).
 * Orders must use that same network. The engine only builds an executor for demo and live, where the two match.
 */
export function createHyperliquidRuntime(opts: { infoTestnet: boolean; bookCoinLimit: number; extraCoins?: () => string[] }): HlRuntime {
  const transport = new HttpTransport({ isTestnet: opts.infoTestnet, timeout: 15_000 });
  const info = limitInfo(new InfoClient({ transport }), new WeightBudget());
  const api = createHlPublicApi({ info, bookCoinLimit: opts.bookCoinLimit, extraCoins: opts.extraCoins });
  return {
    api,
    executor(args) {
      if (args.orderTestnet !== opts.infoTestnet) throw new Error("Hyperliquid orders and market data are on different networks");
      const wallets = new Map<BeeId, ReturnType<typeof privateKeyToAccount>>();
      const clients = new Map<BeeId, ExchangeClient>();
      for (const [bee, creds] of Object.entries(args.creds) as [BeeId, HlCreds][]) {
        const wallet = privateKeyToAccount(creds.agentKey);
        wallets.set(bee, wallet);
        clients.set(bee, new ExchangeClient({ transport, wallet }));
      }
      return new HyperliquidExecutor({
        creds: args.creds,
        info,
        exchangeFor: (bee) => {
          const client = clients.get(bee);
          return client ? exchangePort(client) : undefined;
        },
        agentAddress: (bee) => wallets.get(bee)?.address,
        meta: api,
        leverage: args.leverage,
        slippageBps: args.slippageBps,
        takerFeeRate: args.takerFeeRate,
      });
    },
  };
}

/** Crypto coin names on the main perp dex. Setup uses mainnet (the market paper mode trades against). */
export async function fetchHlCoins(isTestnet: boolean): Promise<string[]> {
  const { api } = createHyperliquidRuntime({ infoTestnet: isTestnet, bookCoinLimit: 1 });
  const list = await api.instruments();
  return [...new Set(list.filter((i) => i.kind === "crypto" && i.state === "live").map((i) => i.coin))].sort((a, b) => a.localeCompare(b));
}
