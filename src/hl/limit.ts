/**
 * Hyperliquid's info endpoint allows 1200 request weight per minute per IP.
 * Most info calls weigh 20. l2Book and clearinghouseState weigh 2.
 * candleSnapshot is 20 plus 1 per 60 candles; fundingHistory / userFills / userFunding add 1 per 20 rows.
 * We stop at 1000 so a burst still has room, and we prefer one metaAndAssetCtxs over a call per coin.
 */
export const HL_WEIGHT_LIMIT = 1000;
export const HL_WEIGHT_WINDOW_MS = 60_000;

export const HL_WEIGHT = {
  metaAndAssetCtxs: 20,
  l2Book: 2,
  candleSnapshot: 25,
  fundingHistory: 45,
  clearinghouseState: 2,
  userFunding: 30,
  userFillsByTime: 30,
  extraAgents: 20,
  userAbstraction: 20,
} as const;

export class WeightBudget {
  private used: Array<{ at: number; w: number }> = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private limit = HL_WEIGHT_LIMIT,
    private windowMs = HL_WEIGHT_WINDOW_MS,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** How long to wait before `weight` more fits in the window. 0 means it fits now. */
  delayMs(weight: number): number {
    const now = this.now();
    this.used = this.used.filter((e) => now - e.at < this.windowMs);
    const sum = this.used.reduce((a, e) => a + e.w, 0);
    if (sum + weight <= this.limit) return 0;
    let dropped = 0;
    for (const e of this.used) {
      dropped += e.w;
      if (sum - dropped + weight <= this.limit) return Math.max(0, e.at + this.windowMs - now);
    }
    return this.windowMs;
  }

  /** Reserve `weight`, waiting until the rolling window allows it. Calls are serialised so they can't all sneak in. */
  take(weight: number): Promise<void> {
    const run = this.tail.then(async () => {
      for (;;) {
        const wait = this.delayMs(weight);
        if (wait <= 0) break;
        await this.sleep(wait);
      }
      this.used.push({ at: this.now(), w: weight });
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
