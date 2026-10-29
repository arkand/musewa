// Adapted from Nakama (MIT). See LICENSE.nakama.
import {
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  jidDecode,
  jidEncode,
  makeWASocket,
  type WASocket,
} from "@whiskeysockets/baileys";
import { usePrivateMultiFileAuthState } from "./auth-state";
import { createBaileysLogger } from "./baileys-logger";
import {
  extractInboundText,
  isWhatsAppOutboundEcho,
  parseInboundWhatsAppMessage,
  rememberWhatsAppOutbound,
  type WhatsAppInboundChat,
} from "./inbound-message";
import { maskWhatsAppJid } from "./log-metadata";

export function isChannelDebugEnabled(): boolean {
  return process.env.MUSE_CH_DEBUG === "1";
}

export interface WhatsAppSocketDeps {
  authDir: string;
  onConnected?: (me: { id: string; lid?: string | null }) => void;
  onDisconnected?: () => void;
  onLoggedOut?: () => void;
  onMessage: (data: WhatsAppInboundChat) => Promise<void>;
  onQr?: (qr: string) => void;
}

export interface WhatsAppSocketHandle {
  socket: WASocket | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface DisconnectDiagnostic {
  code?: unknown;
  message?: unknown;
  output?: { statusCode?: number };
}

type DisconnectDiagnosticValue = DisconnectDiagnostic | unknown;

export async function createWhatsAppSocket(
  deps: WhatsAppSocketDeps
): Promise<WhatsAppSocketHandle> {
  const { state, saveCreds } = await usePrivateMultiFileAuthState(deps.authDir);
  let socket: WASocket | null = null;
  let stopped = false;
  let generation = 0;
  let reconnectAttempt = 0;
  const baileysLogger = createBaileysLogger();

  const handle: WhatsAppSocketHandle = {
    get socket() {
      return socket;
    },
    async start() {
      if (stopped) {
        return;
      }

      const myGen = ++generation;
      const previous = socket;
      socket = null;
      void retireSocket(previous);

      const next = makeWASocket({
        auth: state,
        browser: ["Muse WhatsApp Bridge", "Chrome", "1.0.0"],
        connectTimeoutMs: 30_000,
        logger: baileysLogger,
        makeSignalRepository(auth, logger, pnToLIDFunc) {
          const repository = DEFAULT_CONNECTION_CONFIG.makeSignalRepository(
            auth,
            logger,
            pnToLIDFunc
          );
          const decrypt = repository.decryptMessage.bind(repository);
          const recovered = new Map<string, string>();

          repository.decryptMessage = async (message) => {
            const sender = jidDecode(message.jid);
            const pn = jidDecode(state.creds.me?.id);
            const lid = jidDecode(state.creds.me?.lid);
            const alternate =
              sender?.server === "lid" && sender.user === lid?.user
                ? pn
                : sender?.server === "s.whatsapp.net" &&
                    sender.user === pn?.user
                  ? lid
                  : undefined;

            if (!(sender && alternate)) {
              return decrypt(message);
            }

            const alternateJid = jidEncode(
              alternate.user,
              alternate.server,
              sender.device
            );
            const primary = recovered.get(message.jid) ?? message.jid;

            try {
              return await decrypt({ ...message, jid: primary });
            } catch (error) {
              if (
                !(error instanceof Error) ||
                (error.name !== "SessionError" && error.message !== "Bad MAC")
              ) {
                throw error;
              }

              const fallback =
                primary === message.jid ? alternateJid : message.jid;

              try {
                const plaintext = await decrypt({ ...message, jid: fallback });
                recovered.set(message.jid, fallback);
                return plaintext;
              } catch {
                throw error;
              }
            }
          };

          return repository;
        },
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        retryRequestDelayMs: 2000,
        syncFullHistory: false,
      });

      if (myGen !== generation || stopped) {
        void retireSocket(next);
        return;
      }

      socket = next;
      wrapSocketSendMessage(next);

      next.ev.on("connection.update", async (update) => {
        if (myGen !== generation) {
          return;
        }

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          deps.onQr?.(qr);
        }

        if (connection === "open") {
          reconnectAttempt = 0;
          const me = state.creds.me;

          if (me?.id) {
            deps.onConnected?.({ id: me.id, lid: me.lid ?? null });
          }
        }

        if (connection === "close") {
          generation += 1;
          next.ev.destroy();
          deps.onDisconnected?.();

          const error = lastDisconnect?.error as
            | {
                output?: { statusCode?: number };
                cause?: DisconnectDiagnosticValue;
                data?: DisconnectDiagnosticValue;
              }
            | undefined;
          const statusCode = error?.output?.statusCode;
          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut && !stopped;

          console.log(
            `WhatsApp disconnected ${JSON.stringify({
              cause: safeDisconnectReason(error?.cause ?? error?.data),
              code: statusCode ?? null,
              message: safeDisconnectReason(error),
              reconnect: shouldReconnect,
              timestamp: new Date().toISOString(),
            })}`
          );

          if (!shouldReconnect) {
            if (statusCode === DisconnectReason.loggedOut) {
              deps.onLoggedOut?.();
            }

            return;
          }

          const waitMs =
            Math.min(60_000, 1000 * 2 ** Math.min(reconnectAttempt, 6)) +
            Math.floor(Math.random() * 500);
          reconnectAttempt += 1;

          await new Promise<void>((resolve) => {
            setTimeout(resolve, waitMs);
          });

          if (stopped) {
            return;
          }

          await handle.start();
        }
      });

      next.ev.on("creds.update", saveCreds);

      next.ev.on("messages.upsert", async (event) => {
        if (myGen !== generation || stopped) {
          return;
        }

        if (event.type !== "notify" && event.type !== "append") {
          return;
        }

        const me = state.creds.me;

        for (const message of event.messages) {
          const remoteJid = message.key.remoteJid ?? null;
          const text = extractInboundText(message.message);
          const inbound = parseInboundWhatsAppMessage(message, me, {
            requireGroupMention: false,
          });

          if (remoteJid && isChannelDebugEnabled()) {
            console.log(
              `WhatsApp upsert item id=${message.key.id ?? "-"} jid=${maskWhatsAppJid(remoteJid)} fromMe=${message.key.fromMe ? "yes" : "no"} textBytes=${Buffer.byteLength(text, "utf8")} handle=${inbound ? "yes" : "no"}`
            );
          }

          if (
            !inbound ||
            isWhatsAppOutboundEcho({
              fromMe: inbound.fromMe,
              id: inbound.messageId,
              jid: inbound.jid,
              text: inbound.text,
            })
          ) {
            continue;
          }

          if (myGen !== generation || stopped) {
            return;
          }

          try {
            await deps.onMessage(inbound);
          } catch (error) {
            console.error("WhatsApp inbound message handling failed.", {
              error: error instanceof Error ? error.message : String(error),
              jid: maskWhatsAppJid(inbound.jid),
              messageId: message.key.id ?? null,
            });
          }
        }
      });
    },
    async stop() {
      stopped = true;
      generation += 1;
      const current = socket;
      socket = null;
      await retireSocket(current);
    },
  };

  return handle;
}

function safeDisconnectReason(
  error: DisconnectDiagnosticValue | null | undefined
): string | null {
  if (error === null || error === undefined) {
    return null;
  }

  const diagnostic: DisconnectDiagnostic =
    error instanceof Object ? error : { message: error };
  const message = String(diagnostic.message ?? "");
  const code = String(diagnostic.code ?? "");

  if (
    /^(QR refs attempts ended|Timed Out|Connection was lost|Connection Closed|Connection Terminated|Connection Terminated by Server|Connection Failure|Logged Out|Intentional Logout|Restart Required|Pre-key upload timeout|Multi-device beta not joined|Stream Errored \((conflict|restart required|connection failure)\))$/.test(
      message
    )
  ) {
    return message;
  }

  if (
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH)$/.test(
      code
    )
  ) {
    return code;
  }

  return "[redacted]";
}

function wrapSocketSendMessage(target: WASocket): void {
  if (!target.sendMessage) {
    return;
  }

  const sendMessage = target.sendMessage.bind(target);
  target.sendMessage = ((jid, content, options) => {
    const text = outboundTextFromContent(content);

    if (text) {
      rememberWhatsAppOutbound({ jid, text });
    }

    return Promise.resolve(sendMessage(jid, content, options)).then(
      (result) => {
        rememberWhatsAppOutbound({
          id: result?.key?.id ?? null,
          jid,
          text,
        });
        return result;
      }
    );
  }) as WASocket["sendMessage"];
}

function outboundTextFromContent(
  content: Parameters<WASocket["sendMessage"]>[1]
): string {
  if ("text" in content && content.text?.trim()) {
    return content.text;
  }

  if ("caption" in content && content.caption) {
    return content.caption;
  }

  return "";
}

function retireSocket(target: WASocket | null | undefined): Promise<void> {
  if (!target) {
    return Promise.resolve();
  }

  target.ev.destroy();

  return Promise.resolve(target.end(undefined));
}
