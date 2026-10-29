import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app";
import type { BridgeConfig } from "./config";
import type { WhatsAppInboundChat } from "./whatsapp/inbound-message";
import type {
  WhatsAppSocketDeps,
  WhatsAppSocketHandle,
} from "./whatsapp/socket";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-app-"));
  directories.push(directory);
  return directory;
}

function inbound(): WhatsAppInboundChat {
  return {
    fromMe: false,
    isGroup: false,
    jid: "6281234567890@s.whatsapp.net",
    me: { id: "6289999999999@s.whatsapp.net" },
    mentionedJids: [],
    messageId: "m1",
    quotedParticipant: null,
    quotedText: null,
    senderJid: "6281234567890@s.whatsapp.net",
    senderJids: ["6281234567890@s.whatsapp.net"],
    text: "hello",
  };
}

describe("startApp", () => {
  test("wires the socket handler to Muse and sends the reply", async () => {
    const stateDir = await tempDirectory();
    const config: BridgeConfig = {
      groupRequireMention: true,
      historyMaxTurns: 20,
      museBaseUrl: "http://muse.local/v1",
      museModel: "muse-1",
      requestTimeoutMs: 1000,
      stateDir,
    };
    await writeFile(
      join(stateDir, "allowlist.json"),
      JSON.stringify({
        dm: ["6281234567890@s.whatsapp.net"],
        groups: {},
      })
    );

    let captured: WhatsAppSocketDeps | null = null;
    const sent: string[] = [];
    const socketFactory = async (
      deps: WhatsAppSocketDeps
    ): Promise<WhatsAppSocketHandle> => {
      captured = deps;
      return {
        socket: {
          sendMessage: async (_jid: string, content: { text: string }) => {
            sent.push(content.text);
            return { key: { id: "out-1" } };
          },
          sendPresenceUpdate: async () => {},
        } as never,
        start: async () => {},
        stop: async () => {},
      };
    };
    const muse = { chat: async () => "hello back" };

    const app = await startApp(config, { muse, socketFactory });

    expect(captured).not.toBeNull();
    if (captured) {
      await (captured as WhatsAppSocketDeps).onMessage(inbound());
    }

    expect(sent).toEqual(["hello back"]);
    await app.stop();
  });

  test("calls a real OpenAI-compatible server through MuseClient", async () => {
    const stateDir = await tempDirectory();
    const server = Bun.serve({
      fetch: () =>
        Response.json({
          choices: [{ message: { content: "from the server" } }],
        }),
      port: 0,
    });
    const config: BridgeConfig = {
      groupRequireMention: true,
      historyMaxTurns: 20,
      museBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      museModel: "muse-1",
      requestTimeoutMs: 1000,
      stateDir,
    };
    await writeFile(
      join(stateDir, "allowlist.json"),
      JSON.stringify({
        dm: ["6281234567890@s.whatsapp.net"],
        groups: {},
      })
    );

    let captured: WhatsAppSocketDeps | null = null;
    const sent: string[] = [];
    const socketFactory = async (
      deps: WhatsAppSocketDeps
    ): Promise<WhatsAppSocketHandle> => {
      captured = deps;
      return {
        socket: {
          sendMessage: async (_jid: string, content: { text: string }) => {
            sent.push(content.text);
            return { key: { id: "out-1" } };
          },
          sendPresenceUpdate: async () => {},
        } as never,
        start: async () => {},
        stop: async () => {},
      };
    };

    try {
      const app = await startApp(config, { socketFactory });

      if (captured) {
        await (captured as WhatsAppSocketDeps).onMessage(inbound());
      }

      expect(sent).toEqual(["from the server"]);
      await app.stop();
    } finally {
      server.stop(true);
    }
  });
});
