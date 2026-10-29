import {
  type AllowlistFile,
  isDmAllowed,
  isGroupConfigured,
  isGroupSenderAllowed,
} from "../access/allowlist";
import type { BridgeConfig } from "../config";
import type { ChatClient, MuseMessage } from "../muse/client";
import type { ChatMessage } from "../muse/history";
import { prepareWhatsAppReply, splitWhatsAppMessage } from "../whatsapp/format";
import {
  explainGroupMessageHandling,
  stripWhatsAppBotMention,
} from "../whatsapp/group-message";
import type { WhatsAppInboundChat } from "../whatsapp/inbound-message";
import { ConcurrencyLimiter, MessageDeduper, RateLimiter } from "./guards";

const MAX_INPUT_BYTES = 16 * 1024;
const ERROR_REPLY = "Muse is not available right now. Please try again.";

interface Logger {
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

interface HistoryWriter {
  append: (key: string, message: ChatMessage) => Promise<void>;
  get: (key: string) => ChatMessage[];
}

export interface HandlerDeps {
  concurrency?: ConcurrencyLimiter;
  config: BridgeConfig;
  deduper?: MessageDeduper;
  getAllowlist: () => AllowlistFile;
  history: HistoryWriter;
  logger?: Logger;
  muse: ChatClient;
  rateLimiter?: RateLimiter;
  refreshAllowlist: () => Promise<AllowlistFile>;
  sendText: (jid: string, text: string) => Promise<void>;
  sendTyping: (jid: string, state: "composing" | "paused") => Promise<void>;
}

export function createHandler(deps: HandlerDeps) {
  const deduper = deps.deduper ?? new MessageDeduper();
  const rateLimiter = deps.rateLimiter ?? new RateLimiter();
  const concurrency = deps.concurrency ?? new ConcurrencyLimiter(4);
  const locks = new Set<string>();
  const logger = deps.logger ?? console;

  return async function handleMessage(
    inbound: WhatsAppInboundChat
  ): Promise<void> {
    const text = inbound.text.trim();

    if (!text || inbound.fromMe) {
      return;
    }

    if (deduper.has(inbound.messageId)) {
      return;
    }

    deduper.remember(inbound.messageId);

    const allowlist = await deps.refreshAllowlist();
    const senderKey = inbound.senderJid || inbound.jid;

    if (!rateLimiter.allow(senderKey)) {
      return;
    }

    if (inbound.isGroup) {
      const decision = explainGroupMessageHandling({
        me: inbound.me,
        mentionedJids: inbound.mentionedJids,
        quotedParticipant: inbound.quotedParticipant,
        requireMention: deps.config.groupRequireMention,
        text,
      });

      if (!decision.shouldHandle) {
        return;
      }

      if (!isGroupConfigured(allowlist, inbound.jid)) {
        return;
      }

      if (!isGroupSenderAllowed(allowlist, inbound.jid, inbound.senderJids)) {
        return;
      }
    } else if (!isDmAllowed(allowlist, inbound.senderJids)) {
      return;
    }

    const conversationKey = inbound.jid;

    if (locks.has(conversationKey)) {
      return;
    }

    locks.add(conversationKey);

    try {
      try {
        await deps.sendTyping(inbound.jid, "composing");
      } catch {
        // Typing is best effort. Never block the reply.
      }

      const content = inbound.isGroup
        ? `[sender: ${senderLabel(inbound.senderJid)}] ${stripWhatsAppBotMention(text)}`
        : text;
      const userContent = truncateUtf8(content, MAX_INPUT_BYTES);

      await deps.history.append(conversationKey, {
        content: userContent,
        role: "user",
      });

      const messages: MuseMessage[] = [
        ...(deps.config.museSystemPrompt
          ? [
              {
                content: deps.config.museSystemPrompt,
                role: "system" as const,
              },
            ]
          : []),
        ...deps.history.get(conversationKey),
      ];

      const reply = await concurrency.run(() => deps.muse.chat(messages));

      await deps.history.append(conversationKey, {
        content: reply,
        role: "assistant",
      });

      for (const part of splitWhatsAppMessage(prepareWhatsAppReply(reply))) {
        await deps.sendText(inbound.jid, part);
      }
    } catch (error) {
      logger.error("Muse reply failed.", {
        error: error instanceof Error ? error.message : String(error),
        jid: inbound.jid,
      });

      try {
        await deps.sendText(inbound.jid, ERROR_REPLY);
      } catch {
        // The WhatsApp connection is down. The reconnect loop will recover.
      }
    } finally {
      try {
        await deps.sendTyping(inbound.jid, "paused");
      } catch {
        // Typing is best effort.
      }

      locks.delete(conversationKey);
    }
  };
}

function senderLabel(jid: string): string {
  const [user = "", server = ""] = jid.split("@");
  const digits = user.split(":")[0] ?? user;

  return server === "s.whatsapp.net" ? `+${digits}` : jid;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  let result = text;

  while (Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, -1);
  }

  return result;
}
