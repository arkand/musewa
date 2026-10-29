import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter, MessageDeduper, RateLimiter } from "./guards";

describe("MessageDeduper", () => {
  test("remembers an id for the ttl", () => {
    let now = 0;
    const deduper = new MessageDeduper(1000, () => now);

    expect(deduper.has("m1")).toBe(false);
    deduper.remember("m1");
    expect(deduper.has("m1")).toBe(true);

    now = 1001;
    expect(deduper.has("m1")).toBe(false);
  });

  test("ignores a null id", () => {
    const deduper = new MessageDeduper();

    deduper.remember(null);

    expect(deduper.has(null)).toBe(false);
  });
});

describe("RateLimiter", () => {
  test("allows the limit and blocks the next message in the window", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);

    expect(limiter.allow("sender")).toBe(true);
    expect(limiter.allow("sender")).toBe(true);
    expect(limiter.allow("sender")).toBe(false);
    expect(limiter.allow("other")).toBe(true);

    now = 1001;
    expect(limiter.allow("sender")).toBe(true);
  });
});

describe("ConcurrencyLimiter", () => {
  test("caps active tasks and resumes waiters", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };

    await Promise.all(Array.from({ length: 5 }, () => limiter.run(task)));

    expect(maxActive).toBe(2);
  });
});
