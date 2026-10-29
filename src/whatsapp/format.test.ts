import { describe, expect, test } from "bun:test";
import { prepareWhatsAppReply, splitWhatsAppMessage } from "./format";

describe("WhatsApp formatting", () => {
  test("strips code fences, headings, and backticks", () => {
    const fence = "`".repeat(3);
    const input = [
      `${fence}ts`,
      "const a = 1;",
      fence,
      "# Title",
      "Use `this` now.",
    ].join("\n");

    expect(prepareWhatsAppReply(input)).toBe(
      "const a = 1;\nTitle\nUse this now."
    );
  });

  test("keeps bold and italics in WhatsApp form", () => {
    expect(prepareWhatsAppReply("**bold** and _italic_")).toBe(
      "*bold* and _italic_"
    );
  });

  test("returns one bubble for a short reply", () => {
    expect(splitWhatsAppMessage("hello")).toEqual(["hello"]);
  });

  test("splits a long reply into bubbles near 400 characters", () => {
    const paragraph = "word ".repeat(120).trim();
    const parts = splitWhatsAppMessage(`${paragraph}\n\n${paragraph}`);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 400)).toBe(true);
  });

  test("splits a single huge paragraph", () => {
    const parts = splitWhatsAppMessage("a".repeat(900));

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 400)).toBe(true);
  });
});
