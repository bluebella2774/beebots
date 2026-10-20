// The door the Beekeeper's Zap delivers a rewrite through: POST /lab/overlay.
// Every request carries
//   x-lab-ts:  the request time, unix milliseconds
//   x-lab-sig: hex HMAC-SHA256(key, `${ts}.${METHOD}.${path}.${body}`)   (path without query, body = raw bytes, "" for GET)
// within 5 minutes of the engine's clock, and each signature works once.
//
// The normal key is a round key: each round the Beekeeper starts (keeper.ts) carries a 15-minute key, and a request
// signed with a live round key may POST /lab/overlay once, nothing else.
//
// There is a second, optional key for people who script their own engine: LAB_SECRET (at least 32 characters). A
// request signed with it may also POST /lab/rollback and /lab/round and GET /lab/state. With no LAB_SECRET and the
// Beekeeper off, the whole door answers 404, like any unknown path.
//
// An overlay is ONLY rules text + coins for one bee (lab/brain.ts). The request schema is strict, so a request that
// tries to set anything else (leverage, stops, caps, mode...) is refused outright.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { BEES, type BeeId } from "../config.js";
import { log } from "../log.js";
import { redact, safeError } from "../redact.js";
import type { LabStore, Overlay } from "./store.js";

export const LAB_MIN_SECRET = 32;
export const LAB_WINDOW_MS = 5 * 60_000;
/** Server-enforced: at most one overlay change per bee per 20 hours (a rollback is always allowed, and counts). */
export const LAB_MIN_INTERVAL_MS = 20 * 3_600_000;
export const LAB_MAX_BODY = 16 * 1024;
const MAX_METRICS_JSON = 4096;
const MAX_REMEMBERED_SIGS = 5000;

/** The Beekeeper's side of the door (keeper.ts). */
export interface LabRounds {
  /** The Beekeeper is connected (it has a hook to call). */
  readonly enabled: boolean;
  liveKeys(): Array<{ round: number; key: string }>;
  rewrote(round: number | null, o: Overlay, metrics: Record<string, unknown> | undefined): void;
  refused(round: number, bee: string | null, detail: string): void;
  /** Why a round key may not rewrite this bee right now (it is retired, the experiment is closing), or null. */
  forbids(bee: BeeId): string | null;
  /** `toOwner`: the bee is back on its owner's own rules (no overlay left). */
  rolledBack(bee: BeeId, reason: string, toOwner: boolean): void;
  start(source: "manual", alert?: string): Promise<number | null>;
}

export interface LabDeps {
  store: LabStore;
  /** Unset = only the Beekeeper's round keys open the door. */
  secret?: string;
  rounds?: LabRounds;
  /** Tickers of the crypto X-Perps that are live on OKX right now. */
  knownCoins: () => string[];
  /** The overlay's coins this bee can really trade (lab/brain.ts). */
  effectiveCoins: (bee: BeeId, coins: string[]) => string[];
  /** Told about every change (the engine's alert webhook). Never given the rules text. */
  notify?: (text: string) => void;
  now?: () => number;
}

export interface Reply {
  status: number;
  body: unknown;
}

const Bee = z.enum(BEES);
const OverlayReq = z
  .object({
    bee: Bee,
    rules: z.string(),
    coins: z.array(z.string()).max(20),
    reason: z.string().trim().min(1).max(300),
    /** The numbers and words behind the change, flat (name -> number, text, true/false or null). */
    metrics: z.record(z.union([z.number(), z.string().max(200), z.boolean(), z.null()])).optional(),
  })
  .strict();
const RoundReq = z.object({ note: z.string().trim().max(300).optional() }).strict();
const RollbackReq = z.object({ bee: Bee, reason: z.string().trim().min(1).max(300) }).strict();

/** Text the redactor would change can't be stored: it would come back masked (and it looks like a secret anyway). */
const survivesRedact = (v: unknown) => JSON.stringify(redact(v)) === JSON.stringify(v);

export class LabDoor {
  private seen = new Map<string, number>();
  private now: () => number;

  constructor(private d: LabDeps) {
    this.now = d.now ?? Date.now;
  }

  static enabled(secret: string | undefined): secret is string {
    return !!secret && secret.length >= LAB_MIN_SECRET;
  }

  /** false = nothing could open the door right now, so it answers 404. */
  get open(): boolean {
    return LabDoor.enabled(this.d.secret) || !!this.d.rounds?.enabled;
  }

  /** Checks time window, signature and replay. Returns null when good, else the reason (never shown to the caller). */
  verify(method: string, path: string, body: string, tsHeader: string | undefined, sigHeader: string | undefined): string | null {
    const a = this.auth(method, path, body, tsHeader, sigHeader);
    return "why" in a ? a.why : null;
  }

  /** verify(), plus who signed: `round` is null for LAB_SECRET, or the Beekeeper round whose key signed it. */
  auth(method: string, path: string, body: string, tsHeader: string | undefined, sigHeader: string | undefined): { why: string } | { round: number | null } {
    const now = this.now();
    if (!tsHeader || !/^\d{10,16}$/.test(tsHeader)) return { why: "bad ts" };
    const ts = Number(tsHeader);
    if (Math.abs(now - ts) > LAB_WINDOW_MS) return { why: "stale ts" };
    if (!sigHeader || !/^[0-9a-f]{64}$/i.test(sigHeader)) return { why: "bad sig" };
    const got = Buffer.from(sigHeader, "hex");
    const signedBy = (key: string) => {
      const want = createHmac("sha256", key).update(`${tsHeader}.${method}.${path}.${body}`).digest();
      return got.length === want.length && timingSafeEqual(got, want);
    };
    let round: number | null = null;
    if (!(LabDoor.enabled(this.d.secret) && signedBy(this.d.secret))) {
      const k = (this.d.rounds?.liveKeys() ?? []).find((x) => signedBy(x.key));
      if (!k) return { why: "wrong sig" };
      if (method !== "POST" || path !== "/lab/overlay") return { why: "round key on a path it cannot use" };
      round = k.round;
    }
    const why = this.remember(sigHeader, ts, now);
    return why ? { why } : { round };
  }

  private remember(sigHeader: string, ts: number, now: number): string | null {
    for (const [s, exp] of this.seen) if (exp < now) this.seen.delete(s);
    const key = sigHeader.toLowerCase();
    if (this.seen.has(key)) return "replay";
    if (this.seen.size >= MAX_REMEMBERED_SIGS) return "too many requests";
    this.seen.set(key, ts + LAB_WINDOW_MS + 1000);
    return null;
  }

  /** Time the bee's rules may next be changed, or null when they may be changed now. */
  lockedUntil(bee: BeeId): number | null {
    const last = this.d.store.lastChangeAt(bee);
    return last === null ? null : last + LAB_MIN_INTERVAL_MS;
  }

  private publicOverlay(o: Overlay | null) {
    return o ? { id: o.id, rules: o.rules, coins: o.coins, effectiveCoins: this.d.effectiveCoins(o.bee, o.coins), reason: o.reason, updatedAt: o.updatedAt } : null;
  }

  state(): Reply {
    const overlays = Object.fromEntries(BEES.map((b) => [b, this.publicOverlay(this.d.store.overlay(b))]));
    const nextChangeAt = Object.fromEntries(BEES.map((b) => [b, this.lockedUntil(b)]));
    return { status: 200, body: { now: this.now(), minIntervalHours: LAB_MIN_INTERVAL_MS / 3_600_000, overlays, nextChangeAt, history: this.d.store.history(50) } };
  }

  private rateLimited(bee: BeeId): Reply | null {
    const last = this.d.store.lastChangeAt(bee);
    if (last !== null && this.now() - last < LAB_MIN_INTERVAL_MS) {
      return { status: 429, body: { error: `${bee} changed less than 20 hours ago`, nextChangeAt: last + LAB_MIN_INTERVAL_MS } };
    }
    return null;
  }

  /** `round`: the Beekeeper round whose key signed the request (null = LAB_SECRET). A refusal is written on that round. */
  setOverlay(raw: unknown, round: number | null = null): Reply {
    const r = this.trySetOverlay(raw, round);
    if (r.status !== 200 && round !== null) {
      const body = r.body as { error?: string; issues?: string[]; coins?: string[] };
      const bee = raw && typeof raw === "object" && typeof (raw as { bee?: unknown }).bee === "string" ? (raw as { bee: string }).bee : null;
      this.d.rounds?.refused(round, bee, `${r.status} ${body.error ?? ""} ${(body.issues ?? body.coins ?? []).join("; ")}`.trim());
    }
    return r;
  }

  private trySetOverlay(raw: unknown, round: number | null): Reply {
    const p = OverlayReq.safeParse(raw);
    if (!p.success) return { status: 400, body: { error: "invalid request", issues: p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).slice(0, 10) } };
    const { bee, reason, metrics } = p.data;
    const rules = p.data.rules.replace(/\s+/g, " ").trim();
    if (rules.length < 10 || rules.length > 500) return { status: 400, body: { error: "rules must be 10-500 characters" } };
    const coins = [...new Set(p.data.coins.map((c) => c.trim().toUpperCase()))];
    const known = new Set(this.d.knownCoins().map((c) => c.toUpperCase()));
    if (coins.length && !known.size) return { status: 503, body: { error: "coin list not loaded yet, try again shortly" } };
    const unknown = coins.filter((c) => !known.has(c));
    if (unknown.length) return { status: 400, body: { error: "not a live crypto X-Perp", coins: unknown.slice(0, 20) } };
    if (metrics !== undefined && JSON.stringify(metrics).length > MAX_METRICS_JSON) return { status: 400, body: { error: "metrics over 4 KB" } };
    if (!survivesRedact(rules) || !survivesRedact(reason) || (metrics !== undefined && !survivesRedact(metrics))) {
      return { status: 400, body: { error: "rules, reason or metrics contain text the redactor would mask (long ids, addresses, key-like fields)" } };
    }
    const limited = this.rateLimited(bee);
    if (limited) return limited;
    const no = round !== null ? (this.d.rounds?.forbids(bee) ?? null) : null;
    if (no) return { status: 409, body: { error: no } };
    const o = this.d.store.set(bee, rules, coins, reason, metrics, this.now());
    log.info("beekeeper overlay set", { bee, overlay: o.id, coins: o.coins.length });
    // The change is made: a failure to announce it must not turn the answer into an error.
    this.after(() => this.d.notify?.(`Beekeeper: new rules for ${bee} (rewrite #${o.id}), applied on the next tick`));
    this.after(() => this.d.rounds?.rewrote(round, o, metrics));
    return { status: 200, body: { ok: true, bee, overlay: this.publicOverlay(o) } };
  }

  private after(announce: () => void): void {
    try {
      announce();
    } catch (err) {
      log.warn("beekeeper change made but not announced", { err: safeError(err) });
    }
  }

  /** POST /lab/round: start a Beekeeper round now (it answers at once; the round runs on the Zap's side). */
  async round(raw: unknown): Promise<Reply> {
    const p = RoundReq.safeParse(raw);
    if (!p.success) return { status: 400, body: { error: "invalid request" } };
    const id = (await this.d.rounds?.start("manual", p.data.note)) ?? null;
    return id === null ? { status: 409, body: { error: "the Beekeeper is not connected" } } : { status: 200, body: { ok: true, round: id } };
  }

  /** Undo the bee's latest rewrite: back to the overlay before it, or to the owner's own rules when there is none. */
  rollback(raw: unknown): Reply {
    const p = RollbackReq.safeParse(raw);
    if (!p.success) return { status: 400, body: { error: "invalid request", issues: p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).slice(0, 10) } };
    const { bee, reason } = p.data;
    if (!survivesRedact(reason)) return { status: 400, body: { error: "reason contains text the redactor would mask" } };
    const r = this.d.store.rollback(bee, reason, this.now());
    if (!r) return { status: 409, body: { error: `${bee} has no rewrite to undo` } };
    log.info("beekeeper overlay rolled back", { bee, undid: r.undid, restored: r.restored?.id ?? null });
    this.after(() => this.d.notify?.(`Beekeeper: ${bee} rolled back from rewrite #${r.undid} to ${r.restored ? `#${r.restored.id}` : "its owner's rules"}`));
    this.after(() => this.d.rounds?.rolledBack(bee, reason, r.restored === null));
    return { status: 200, body: { ok: true, bee, undid: r.undid, overlay: this.publicOverlay(r.restored) } };
  }
}

function send(res: ServerResponse, r: Reply) {
  res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(redact(r.body)));
}

function readRaw(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > LAB_MAX_BODY) {
      req.resume();
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LAB_MAX_BODY) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const ROUTES: Record<string, string> = { "/lab/overlay": "POST", "/lab/rollback": "POST", "/lab/round": "POST", "/lab/state": "GET" };

/**
 * Handles /lab/*. `door` is null in setup mode; a door nothing can open (no LAB_SECRET, Beekeeper off) is a plain 404
 * too. Returns false for paths outside /lab/. Never throws and never rejects: every failure is an HTTP answer.
 */
export function handleLab(req: IncomingMessage, res: ServerResponse, url: URL, door: LabDoor | null): boolean {
  const p = url.pathname;
  if (!p.startsWith("/lab/")) return false;
  const method = (req.method ?? "GET").toUpperCase();
  if (!door || !door.open || !ROUTES[p]) {
    req.resume();
    send(res, { status: 404, body: { error: "not found" } });
    return true;
  }
  readRaw(req)
    .then((body) => {
      if (body === null) return send(res, { status: 413, body: { error: "body over 16 KB" } });
      const who = door.auth(method, p, body, header(req, "x-lab-ts"), header(req, "x-lab-sig"));
      if ("why" in who) {
        log.warn("lab request refused", { path: p, why: who.why });
        return send(res, { status: 401, body: { error: "unauthorized" } });
      }
      if (method !== ROUTES[p]) return send(res, { status: 405, body: { error: `${ROUTES[p]} only` } });
      if (method === "GET") return send(res, door.state());
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return send(res, { status: 400, body: { error: "body is not valid JSON" } });
      }
      if (p === "/lab/round") return door.round(json).then((r) => send(res, r));
      send(res, p === "/lab/overlay" ? door.setOverlay(json, who.round) : door.rollback(json));
    })
    .catch((e: unknown) => {
      log.error("lab request failed", { err: safeError(e) });
      if (!res.headersSent) send(res, { status: 500, body: { error: "lab request failed" } });
      else res.end();
    });
  return true;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** For the Zap's last step and for tests: the signature for one request. */
export function labSignature(secret: string, ts: string, method: string, path: string, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${method}.${path}.${body}`).digest("hex");
}
