import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/discord/rate-limiter.js";

/** A controllable clock: sleeping advances virtual time instead of waiting. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      current += ms;
    },
    get time() {
      return current;
    },
  };
}

describe("RateLimiter", () => {
  it("allows an initial burst up to capacity without waiting", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerSecond: 5, burst: 5, ...clock });

    for (let i = 0; i < 5; i += 1) await limiter.acquire();

    expect(clock.time).toBe(0);
  });

  it("paces requests once the burst is spent", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerSecond: 5, burst: 5, ...clock });

    for (let i = 0; i < 5; i += 1) await limiter.acquire();
    await limiter.acquire(); // the 6th must wait for a token to refill

    // At 5/s a token takes 200ms.
    expect(clock.time).toBeGreaterThanOrEqual(200);
  });

  it("holds every caller for the full duration of a global pause", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerSecond: 100, burst: 100, ...clock });

    limiter.pauseFor(5000);
    await limiter.acquire();

    // A global 429 must stop everything, not just the offending route.
    expect(clock.time).toBeGreaterThanOrEqual(5000);
  });

  it("serializes concurrent acquisitions so callers cannot share a token", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerSecond: 1, burst: 1, ...clock });

    const order: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await limiter.acquire();
        order.push(i);
      }),
    );

    expect(order).toEqual([0, 1, 2]);
    // One token up front, then two more at 1/s.
    expect(clock.time).toBeGreaterThanOrEqual(2000);
  });
});
