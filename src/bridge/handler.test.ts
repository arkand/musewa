import { describe, expect, test } from "bun:test";
import type { AllowlistFile } from "../access/allowlist";
import type { BridgeConfig } from "../config";
import type { MuseMessage } from "../muse/client";
import type { ChatMessage } from "../muse/history";
import type { WhatsAppInboundChat } from "../whatsapp/inbound-message";
import { ConcurrencyLimiter, MessageDeduper, RateLimiter } from "./guards";
import { createHandler, type HandlerDeps } from "./handler";

const config: BridgeConfig = {
  groupRequireMention: true,
  historyMaxTurns: 20,
  museBaseUrl: "http://muse.local/v1",
  museModel: "muse-1",
  requestTimeoutMs: 1000,
  stateDir: "/tmp/muse",
};

const dmAllowlist: AllowlistFile = {
  dm: ["6281234567890@s.whatsapp.net", "6281234567891@s.whatsapp.net"],
  groups: {
    "120363000000000000@g.us": {
      allowAll: false,
      members: ["6281234567890@s.whatsapp.net"],
    },
  },
};

function inbound(
  overrides: Partial<WhatsAppInboundChat> = {}
): WhatsAppInboundChat {
  return {
    fromMe: false,
    isGroup: false,
    jid: "6281234567890@s.whatsapp.net",
    me: { id: "6289999999999@s.whatsapp.net", lid: "999@lid" },
    mentionedJids: [],
    messageId: "m1",
    quotedParticipant: null,
    quotedText: null,
    senderJid: "6281234567890@s.whatsapp.net",
    senderJids: ["6281234567890@s.whatsapp.net"],
    text: "hello",
    ...overrides,
  };
}

function createDeps(reply = " hi ") {
  const messages: MuseMessage[][] = [];
  const sent: Array<{ jid: string; text: string }> = [];
  const typing: Array<{ jid: string; state: string }> = [];
  const historyByKey = new Map<string, ChatMessage[]>();

  const deps: HandlerDeps = {
    config,
    deduper: new MessageDeduper(),
    getAllowlist: () => dmAllowlist,
    history: {
      append: async (key: string, message: ChatMessage) => {
        historyByKey.set(key, [...(historyByKey.get(key) ?? []), message]);
      },
      get: (key: string) => historyByKey.get(key) ?? [],
    },
    logger: { error: () => {}, info: () => {} },
    muse: {
      chat: async (input: MuseMessage[]) => {
        messages.push(input);
        return reply;
      },
    },
    rateLimiter: new RateLimiter(),
    refreshAllowlist: async () => dmAllowlist,
    sendText: async (jid: string, text: string) => {
      sent.push({ jid, text });
    },
    sendTyping: async (jid: string, state: "composing" | "paused") => {
      typing.push({ jid, state });
    },
  };

  return {
    deps,
    messages,
    sent,
    typing,
  };
}

describe("createHandler", () => {
  test("answers an allowed DM and sends the split reply", async () => {
    const { deps, messages, sent, typing } = createDeps("hello");
    const handler = createHandler(deps);

    await handler(inbound());

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual([{ content: "hello", role: "user" }]);
    expect(sent).toEqual([
      { jid: "6281234567890@s.whatsapp.net", text: "hello" },
    ]);
    expect(typing).toEqual([
      { jid: "6281234567890@s.whatsapp.net", state: "composing" },
      { jid: "6281234567890@s.whatsapp.net", state: "paused" },
    ]);
  });

  test("does not answer an unknown DM", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(
      inbound({
        jid: "999@s.whatsapp.net",
        senderJid: "999@s.whatsapp.net",
        senderJids: ["999@s.whatsapp.net"],
      })
    );

    expect(messages).toHaveLength(0);
  });

  test("answers an allowed group mention with a sender prefix", async () => {
    const { deps, messages } = createDeps("ok");
    const handler = createHandler(deps);

    await handler(
      inbound({
        isGroup: true,
        jid: "120363000000000000@g.us",
        mentionedJids: ["6289999999999@s.whatsapp.net"],
        text: "@Muse hello",
      })
    );

    expect(messages[0]).toEqual([
      {
        content: "[sender: +6281234567890] hello",
        role: "user",
      },
    ]);
  });

  test("ignores a group message without a mention", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(
      inbound({
        isGroup: true,
        jid: "120363000000000000@g.us",
        text: "hello",
      })
    );

    expect(messages).toHaveLength(0);
  });

  test("ignores a group message from a non-member", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(
      inbound({
        isGroup: true,
        jid: "120363000000000000@g.us",
        mentionedJids: ["6289999999999@s.whatsapp.net"],
        senderJid: "999@s.whatsapp.net",
        senderJids: ["999@s.whatsapp.net"],
      })
    );

    expect(messages).toHaveLength(0);
  });

  test("sends one error reply when Muse fails", async () => {
    const { deps, sent } = createDeps();
    deps.muse.chat = async () => {
      throw new Error("down");
    };
    const handler = createHandler(deps);

    await handler(inbound());

    expect(sent).toEqual([
      {
        jid: "6281234567890@s.whatsapp.net",
        text: "Muse is not available right now. Please try again.",
      },
    ]);
  });

  test("does not persist the user turn when Muse fails", async () => {
    const historyByKey = new Map<string, ChatMessage[]>();
    const { deps } = createDeps();
    deps.history = {
      append: async (key: string, message: ChatMessage) => {
        historyByKey.set(key, [...(historyByKey.get(key) ?? []), message]);
      },
      get: (key: string) => historyByKey.get(key) ?? [],
    };
    deps.muse.chat = async () => {
      throw new Error("down");
    };
    const handler = createHandler(deps);

    await handler(inbound());

    expect(historyByKey.get("6281234567890@s.whatsapp.net") ?? []).toEqual([]);
  });

  test("persists the user turn and reply after a successful call", async () => {
    const historyByKey = new Map<string, ChatMessage[]>();
    const { deps } = createDeps("hi back");
    deps.history = {
      append: async (key: string, message: ChatMessage) => {
        historyByKey.set(key, [...(historyByKey.get(key) ?? []), message]);
      },
      get: (key: string) => historyByKey.get(key) ?? [],
    };
    const handler = createHandler(deps);

    await handler(inbound());

    expect(historyByKey.get("6281234567890@s.whatsapp.net")).toEqual([
      { content: "hello", role: "user" },
      { content: "hi back", role: "assistant" },
    ]);
  });

  test("ignores own messages and empty text", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(inbound({ fromMe: true }));
    await handler(inbound({ text: "   " }));

    expect(messages).toHaveLength(0);
  });

  test("ignores media even when it carries a caption", async () => {
    const { deps, messages, sent } = createDeps();
    const handler = createHandler(deps);

    await handler(
      inbound({
        media: { kind: "image", message: {} },
        text: "look at this",
      })
    );

    expect(messages).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("deduplicates a repeated message id", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(inbound());
    await handler(inbound());

    expect(messages).toHaveLength(1);
  });

  test("applies the rate limit", async () => {
    const { deps, messages } = createDeps();
    deps.rateLimiter = new RateLimiter(1, 60_000);
    const handler = createHandler(deps);

    await handler(inbound({ messageId: "m1" }));
    await handler(inbound({ messageId: "m2" }));

    expect(messages).toHaveLength(1);
  });

  test("caps concurrent Muse calls across conversations", async () => {
    const { deps } = createDeps();
    deps.concurrency = new ConcurrencyLimiter(1);
    let active = 0;
    let maxActive = 0;
    deps.muse.chat = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "ok";
    };
    const handler = createHandler(deps);

    await Promise.all([
      handler(
        inbound({
          jid: "6281234567890@s.whatsapp.net",
          messageId: "m1",
        })
      ),
      handler(
        inbound({
          jid: "6281234567891@s.whatsapp.net",
          messageId: "m2",
          senderJid: "6281234567891@s.whatsapp.net",
          senderJids: ["6281234567891@s.whatsapp.net"],
        })
      ),
    ]);

    expect(maxActive).toBe(1);
  });
});
