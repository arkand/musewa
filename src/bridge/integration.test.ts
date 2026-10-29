import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllowlistFile } from "../access/allowlist";
import type { BridgeConfig } from "../config";
import { MuseClient } from "../muse/client";
import { HistoryStore } from "../muse/history";
import type { WhatsAppInboundChat } from "../whatsapp/inbound-message";
import { createHandler } from "./handler";

// End-to-end test: a real Bun.serve fake Muse server, the real MuseClient over
// HTTP, the real HistoryStore writing to disk, and the real handler policy gate.
// Only the WhatsApp transport is replaced by in-memory send/typing collectors.

interface MuseRequestBody {
  messages: Array<{ content: string; role: string }>;
  model: string;
  stream: boolean;
}

interface FakeMuse {
  baseUrl: string;
  readonly requests: MuseRequestBody[];
  setReply: (reply: string | null) => void;
  setStatus: (status: number) => void;
  stop: () => Promise<void>;
}

function startFakeMuse(): FakeMuse {
  const requests: MuseRequestBody[] = [];
  let reply: string | null = "pong";
  let status = 200;

  const server = Bun.serve({
    async fetch(request) {
      if (!request.url.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      requests.push((await request.json()) as MuseRequestBody);

      if (status !== 200) {
        return new Response(`error ${status}`, { status });
      }

      return Response.json({
        choices: [{ message: { content: reply } }],
      });
    },
    port: 0,
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    setReply: (value) => {
      reply = value;
    },
    setStatus: (value) => {
      status = value;
    },
    stop: () => server.stop(true),
  };
}

const allowlist: AllowlistFile = {
  dm: ["6281234567890@s.whatsapp.net"],
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

const directories: string[] = [];
let muse: FakeMuse;

beforeEach(() => {
  muse = startFakeMuse();
});

afterEach(async () => {
  await muse.stop();

  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function buildHandler(systemPrompt?: string) {
  const directory = await mkdtemp(join(tmpdir(), "muse-integration-"));
  directories.push(directory);

  const config: BridgeConfig = {
    groupRequireMention: true,
    historyMaxTurns: 20,
    museBaseUrl: muse.baseUrl,
    museModel: "muse-1",
    museSystemPrompt: systemPrompt,
    requestTimeoutMs: 5000,
    stateDir: directory,
  };

  const history = new HistoryStore(join(directory, "history.json"), 20);
  await history.load();

  const sent: Array<{ jid: string; text: string }> = [];

  const handler = createHandler({
    config,
    getAllowlist: () => allowlist,
    history,
    muse: new MuseClient({
      baseUrl: config.museBaseUrl,
      model: config.museModel,
      timeoutMs: config.requestTimeoutMs,
    }),
    refreshAllowlist: () => Promise.resolve(allowlist),
    sendText: async (jid, text) => {
      sent.push({ jid, text });
    },
    sendTyping: async () => {
      // no-op in the test transport
    },
  });

  return { handler, history, sent };
}

describe("bridge integration over HTTP", () => {
  test("answers an allowed DM by calling the real Muse HTTP endpoint", async () => {
    muse.setReply("hi from muse");
    const { handler, sent } = await buildHandler();

    await handler(inbound());

    expect(muse.requests).toHaveLength(1);
    expect(muse.requests[0]?.model).toBe("muse-1");
    expect(muse.requests[0]?.stream).toBe(false);
    expect(muse.requests[0]?.messages).toEqual([
      { content: "hello", role: "user" },
    ]);
    expect(sent).toEqual([
      { jid: "6281234567890@s.whatsapp.net", text: "hi from muse" },
    ]);
  });

  test("prepends the system prompt when configured", async () => {
    const { handler } = await buildHandler("You are Muse.");

    await handler(inbound());

    expect(muse.requests[0]?.messages).toEqual([
      { content: "You are Muse.", role: "system" },
      { content: "hello", role: "user" },
    ]);
  });

  test("does not call Muse for an unknown DM", async () => {
    const { handler, sent } = await buildHandler();

    await handler(
      inbound({
        jid: "999@s.whatsapp.net",
        senderJid: "999@s.whatsapp.net",
        senderJids: ["999@s.whatsapp.net"],
      })
    );

    expect(muse.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("persists history across turns and sends it back to Muse", async () => {
    muse.setReply("first reply");
    const { handler } = await buildHandler();

    await handler(inbound({ messageId: "m1", text: "first" }));

    muse.setReply("second reply");
    await handler(inbound({ messageId: "m2", text: "second" }));

    expect(muse.requests[1]?.messages).toEqual([
      { content: "first", role: "user" },
      { content: "first reply", role: "assistant" },
      { content: "second", role: "user" },
    ]);
  });

  test("sends one error reply and keeps no history when Muse returns 500", async () => {
    muse.setStatus(500);
    const { handler, history, sent } = await buildHandler();

    await handler(inbound());

    expect(sent).toEqual([
      {
        jid: "6281234567890@s.whatsapp.net",
        text: "Muse is not available right now. Please try again.",
      },
    ]);
    expect(history.get("6281234567890@s.whatsapp.net")).toEqual([]);
  });

  test("reloads persisted history from disk on a fresh store", async () => {
    muse.setReply("remembered");
    const directory = await mkdtemp(join(tmpdir(), "muse-integration-"));
    directories.push(directory);

    const config: BridgeConfig = {
      groupRequireMention: true,
      historyMaxTurns: 20,
      museBaseUrl: muse.baseUrl,
      museModel: "muse-1",
      requestTimeoutMs: 5000,
      stateDir: directory,
    };
    const path = join(directory, "history.json");

    const firstHistory = new HistoryStore(path, 20);
    await firstHistory.load();

    const handler = createHandler({
      config,
      getAllowlist: () => allowlist,
      history: firstHistory,
      muse: new MuseClient({
        baseUrl: config.museBaseUrl,
        model: config.museModel,
        timeoutMs: config.requestTimeoutMs,
      }),
      refreshAllowlist: () => Promise.resolve(allowlist),
      sendText: async () => {
        // no-op
      },
      sendTyping: async () => {
        // no-op
      },
    });

    await handler(inbound({ text: "remember this" }));

    const reloaded = new HistoryStore(path, 20);
    await reloaded.load();

    expect(reloaded.get("6281234567890@s.whatsapp.net")).toEqual([
      { content: "remember this", role: "user" },
      { content: "remembered", role: "assistant" },
    ]);
  });
});
