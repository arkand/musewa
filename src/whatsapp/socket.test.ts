import { afterEach, describe, expect, test } from "bun:test";
import { isChannelDebugEnabled } from "./socket";

describe("isChannelDebugEnabled", () => {
  const previous = process.env.MUSE_CH_DEBUG;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.MUSE_CH_DEBUG;
    } else {
      process.env.MUSE_CH_DEBUG = previous;
    }
  });

  test("is off by default", () => {
    delete process.env.MUSE_CH_DEBUG;
    expect(isChannelDebugEnabled()).toBe(false);
  });

  test("is on when MUSE_CH_DEBUG=1", () => {
    process.env.MUSE_CH_DEBUG = "1";
    expect(isChannelDebugEnabled()).toBe(true);
  });
});
