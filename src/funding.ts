/** When each venue settles funding, as UTC hours. OKX is 00:00, 08:00 and 16:00. Hyperliquid is every hour. */
export const OKX_FUNDING_HOURS_UTC = [0, 8, 16] as const;

/**
 * Hyperliquid's fundingHistory info call returns at most 500 rows, and they start at `startTime`
 * (they are not the latest 500 if you ask for a longer window). 500 hourly points is the useful request.
 */
export const HL_FUNDING_HISTORY_POINTS = 500;

export function fundingHoursUtc(exchange: "okx" | "hyperliquid"): readonly number[] {
  if (exchange === "hyperliquid") return Array.from({ length: 24 }, (_, h) => h);
  return OKX_FUNDING_HOURS_UTC;
}

/** Start of the funding slot that contains `ms`, in unix ms. */
export function fundingSlot(ms: number, hours: readonly number[]): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const slotHour = [...hours].reverse().find((x) => h >= x) ?? hours[0] ?? 0;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slotHour);
}

/**
 * One settlement, using the venue's own rate for that settlement (OKX's 8-hour rate, or Hyperliquid's hourly rate).
 * A long pays when the rate is positive. The caller applies this once per slot, not once per day.
 */
export function fundingPaymentUsd(side: "long" | "short", fundingRate: number, notionalUsd: number): number {
  const sign = side === "long" ? 1 : -1;
  return -sign * fundingRate * notionalUsd;
}
