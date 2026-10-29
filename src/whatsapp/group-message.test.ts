import { describe, expect, test } from "bun:test";
import {
  explainGroupMessageHandling,
  isWhatsAppBotAddress,
  isWhatsAppGroupChat,
  stripWhatsAppBotMention,
  type WhatsAppAccount,
} from "./group-message";

const me: WhatsAppAccount = {
  id: "628100000000@s.whatsapp.net",
  lid: "236283431522503@lid",
};

describe("group-message helpers", () => {
  test("detects group JIDs", () => {
    expect(isWhatsAppGroupChat("120363@g.us")).toBe(true);
    expect(isWhatsAppGroupChat("628100000000@s.whatsapp.net")).toBe(false);
  });

  test("matches bot phone and lid identities", () => {
    expect(isWhatsAppBotAddress("628100000000@s.whatsapp.net", me)).toBe(true);
    expect(isWhatsAppBotAddress("236283431522503@lid", me)).toBe(true);
    expect(isWhatsAppBotAddress("9999999999@s.whatsapp.net", me)).toBe(false);
  });

  test("handles a mention or a reply to the bot", () => {
    expect(
      explainGroupMessageHandling({
        me,
        mentionedJids: ["628100000000@s.whatsapp.net"],
        quotedParticipant: null,
        text: "@Muse hello",
      }).shouldHandle
    ).toBe(true);

    expect(
      explainGroupMessageHandling({
        me,
        mentionedJids: [],
        quotedParticipant: me.lid ?? null,
        text: "follow up",
      }).shouldHandle
    ).toBe(true);
  });

  test("ignores a plain group message when mention is required", () => {
    expect(
      explainGroupMessageHandling({
        me,
        mentionedJids: [],
        quotedParticipant: null,
        text: "hello",
      }).shouldHandle
    ).toBe(false);
  });

  test("accepts plain text when mention is not required", () => {
    expect(
      explainGroupMessageHandling({
        mentionedJids: [],
        quotedParticipant: null,
        requireMention: false,
        text: "hello",
      })
    ).toEqual({ reason: "open-listen", shouldHandle: true });
  });

  test("ignores a message when bot identity is missing", () => {
    expect(
      explainGroupMessageHandling({
        mentionedJids: ["628100000000@s.whatsapp.net"],
        quotedParticipant: null,
        text: "hello",
      })
    ).toEqual({ reason: "missing-bot-info", shouldHandle: false });
  });

  test("strips mention tokens", () => {
    expect(stripWhatsAppBotMention("hi @Muse there")).toBe("hi there");
    expect(stripWhatsAppBotMention("@Muse")).toBe("");
  });
});
