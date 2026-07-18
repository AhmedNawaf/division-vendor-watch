/**
 * A token-bucket limiter shared across every Discord request in a run.
 *
 * Discord's global ceiling is 50 req/s, but that is a ceiling, not a target: the headroom is
 * what absorbs bursts and retries. We pace well below it because our risk is not throughput —
 * a weekly vendor digest is not second-sensitive — it is looking like a bot that blasts.
 *
 * `pauseFor` exists for global 429s. On a global rate limit Discord expects the *entire*
 * process to stop, not just the offending route; continuing to send on other routes is what
 * turns a survivable 429 into an IP-level ban.
 */
export interface RateLimiterOptions {
  /** Sustained request rate. Default 5/s — well under Discord's 50/s global ceiling. */
  requestsPerSecond?: number;
  /** Tokens available for an initial burst. Default 5. */
  burst?: number;
  /** Injectable clock (ms), for tests. */
  now?: () => number;
  /** Injectable delay, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly ratePerMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;
  /** Serializes acquisitions so concurrent callers can't all spend the same token. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    const rps = options.requestsPerSecond ?? 5;
    this.ratePerMs = rps / 1000;
    this.capacity = options.burst ?? Math.max(1, Math.ceil(rps));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** Halt every request for `ms` — use on a global 429, not a per-route one. */
  pauseFor(ms: number): void {
    const until = this.now() + ms;
    if (until > this.pausedUntil) this.pausedUntil = until;
  }

  /** Resolves once this caller is cleared to issue one request. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.take());
    // Keep the chain alive even if one waiter rejects, so later callers aren't stranded.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async take(): Promise<void> {
    for (;;) {
      const now = this.now();

      if (now < this.pausedUntil) {
        await this.sleep(this.pausedUntil - now);
        continue;
      }

      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      await this.sleep(Math.ceil((1 - this.tokens) / this.ratePerMs));
    }
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
    this.lastRefill = now;
  }
}
