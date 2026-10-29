import { describe, expect, test } from "bun:test";
import { normalizePairingPhone, parsePairArgs } from "./pair";

describe("pair CLI", () => {
  test("parses --phone", () => {
    expect(parsePairArgs(["--phone", "+62 812-3456-7890"])).toEqual({
      phone: "+62 812-3456-7890",
    });
  });

  test("parses --phone=value", () => {
    expect(parsePairArgs(["--phone=6281234567890"])).toEqual({
      phone: "6281234567890",
    });
  });

  test("returns an empty result without a phone", () => {
    expect(parsePairArgs([])).toEqual({});
  });

  test("normalizes a phone number to digits", () => {
    expect(normalizePairingPhone("+62 812-3456-7890")).toBe("6281234567890");
  });

  test("rejects a short phone number", () => {
    expect(() => normalizePairingPhone("123")).toThrow(
      "Phone number must have 6 to 15 digits"
    );
  });
});
