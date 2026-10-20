import { createHash } from "node:crypto";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

/** Hyperliquid rejects perp orders below this notional (MinTradeNtl). USDC. */
export const HL_MIN_ORDER_USD = 10;

/** Perp prices: at most 5 significant figures, and at most (6 - szDecimals) decimal places. Integers are always allowed. */
export function formatHlPrice(price: number, szDecimals: number): string {
  return formatPrice(price, szDecimals, "perp");
}

/** Sizes are truncated (not rounded up) to `szDecimals`. */
export function formatHlSize(size: number, szDecimals: number): string {
  return formatSize(size, szDecimals);
}

/**
 * One lot, `10^-szDecimals`. Parsed from a decimal string: `10 ** -5` stringifies as a long float
 * and the shared sizer would then print too many decimal places.
 */
export function lotStep(szDecimals: number): number {
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 8) return Number.NaN;
  return szDecimals === 0 ? 1 : Number(`1e-${szDecimals}`);
}

/** Smallest size whose notional is at least `minUsd`, rounded up to the lot `10^-szDecimals`. */
export function minSizeForNotional(px: number, szDecimals: number, minUsd = HL_MIN_ORDER_USD): number {
  if (!(px > 0) || !Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 8) return Number.POSITIVE_INFINITY;
  const scale = 10 ** szDecimals;
  const lots = Math.ceil((minUsd / px) * scale - 1e-9);
  return lots / scale;
}

/**
 * IOC limit through the touch by `slippageBps`. Formatting rounds toward zero, so a buy stays inside the cap.
 * A sell can land one tick past the cap; the cap is still the price we aim at.
 */
export function iocLimitPrice(mid: number, side: "buy" | "sell", slippageBps: number, szDecimals: number): string {
  if (!(mid > 0)) throw new Error("no mid");
  const slip = slippageBps / 10_000;
  const raw = side === "buy" ? mid * (1 + slip) : mid * (1 - slip);
  return formatHlPrice(raw, szDecimals);
}

/** Hyperliquid cloid: 0x + 16 bytes (34 characters). BeeBots' clOrdId is hashed into that shape. */
export function toCloid(clOrdId: string): `0x${string}` {
  return `0x${createHash("sha256").update(clOrdId).digest("hex").slice(0, 32)}`;
}

/** Perp size is in coins, so notional USDC is contracts × price. */
export function orderNotionalUsd(contracts: number, px: number): number {
  return contracts * px;
}

export function belowMinNotional(contracts: number, px: number, minUsd = HL_MIN_ORDER_USD): boolean {
  return !(orderNotionalUsd(contracts, px) >= minUsd);
}
