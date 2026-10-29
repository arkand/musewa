export class MessageDeduper {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 120_000, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  has(id: string | null): boolean {
    if (!id) {
      return false;
    }

    this.prune();

    return this.seen.has(id);
  }

  remember(id: string | null): void {
    if (!id) {
      return;
    }

    this.prune();
    this.seen.set(id, this.now());
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;

    for (const [id, seenAt] of this.seen) {
      if (seenAt < cutoff) {
        this.seen.delete(id);
      }
    }
  }
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    limit = 20,
    windowMs = 60_000,
    now: () => number = () => Date.now()
  ) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  allow(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff
    );

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);

    if (this.hits.size > 1000) {
      for (const [k, timestamps] of this.hits) {
        if (timestamps.every((t) => t <= cutoff)) {
          this.hits.delete(k);
        }
      }
    }

    return true;
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit = 4) {
    if (limit < 1) {
      throw new Error("Concurrency limit must be at least 1");
    }

    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();

    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();

    if (next) {
      next();
      return;
    }

    this.active -= 1;
  }
}
