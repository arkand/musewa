import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AllowlistStore } from "./access/allowlist";
import { createHandler } from "./bridge/handler";
import type { BridgeConfig } from "./config";
import { type ChatClient, MuseClient } from "./muse/client";
import { HistoryStore } from "./muse/history";
import {
  createWhatsAppSocket,
  type WhatsAppSocketDeps,
  type WhatsAppSocketHandle,
} from "./whatsapp/socket";

export interface AppOptions {
  muse?: Pick<ChatClient, "chat">;
  onLoggedOut?: () => void;
  socketFactory?: (deps: WhatsAppSocketDeps) => Promise<WhatsAppSocketHandle>;
}

export async function startApp(
  config: BridgeConfig,
  options: AppOptions = {}
): Promise<{ stop: () => Promise<void> }> {
  await mkdir(config.stateDir, { mode: 0o700, recursive: true });
  await chmod(config.stateDir, 0o700);

  const allowlist = new AllowlistStore(join(config.stateDir, "allowlist.json"));
  await allowlist.load();

  const history = new HistoryStore(
    join(config.stateDir, "history.json"),
    config.historyMaxTurns
  );
  await history.load();

  const muse: Pick<ChatClient, "chat"> =
    options.muse ??
    new MuseClient({
      apiKey: config.museApiKey,
      baseUrl: config.museBaseUrl,
      model: config.museModel,
      timeoutMs: config.requestTimeoutMs,
    });

  let socketHandle: WhatsAppSocketHandle | null = null;

  const handler = createHandler({
    config,
    getAllowlist: () => allowlist.get(),
    history,
    muse,
    refreshAllowlist: () => allowlist.refresh(),
    sendText: async (jid, text) => {
      const socket = socketHandle?.socket;

      if (!socket) {
        throw new Error("WhatsApp socket is not connected");
      }

      await socket.sendMessage(jid, { text });
    },
    sendTyping: async (jid, state) => {
      await socketHandle?.socket?.sendPresenceUpdate(state, jid);
    },
  });

  const socket = await (options.socketFactory ?? createWhatsAppSocket)({
    authDir: join(config.stateDir, "auth"),
    onLoggedOut: options.onLoggedOut,
    onMessage: handler,
    onQr: () => {
      console.error(
        "WhatsApp requested a new link. Stop the service and run the pairing command."
      );
    },
  });

  socketHandle = socket;
  await socket.start();

  return {
    stop: () => socket.stop(),
  };
}
