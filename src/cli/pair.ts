import { join } from "node:path";
import { DisconnectReason, makeWASocket } from "@whiskeysockets/baileys";
import { loadStateConfig } from "../config";
import { usePrivateMultiFileAuthState } from "../whatsapp/auth-state";
import {
  createBaileysLogger,
  installBaileysConsoleRedaction,
} from "../whatsapp/baileys-logger";

export function parsePairArgs(argv: string[]): { phone?: string } {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--phone") {
      return { phone: argv[index + 1] };
    }

    if (argument?.startsWith("--phone=")) {
      return { phone: argument.slice("--phone=".length) };
    }
  }

  return {};
}

export function normalizePairingPhone(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (!/^\d{6,15}$/.test(digits)) {
    throw new Error("Phone number must have 6 to 15 digits");
  }

  return digits;
}

export async function runPair(argv = process.argv.slice(2)): Promise<void> {
  installBaileysConsoleRedaction();

  const { stateDir, whatsappPhoneNumber } = loadStateConfig();
  const parsed = parsePairArgs(argv);
  const phone = parsed.phone ?? whatsappPhoneNumber;

  if (!phone) {
    throw new Error("Pass --phone +<number> or set WHATSAPP_PHONE_NUMBER.");
  }

  const normalizedPhone = normalizePairingPhone(phone);
  const authDir = join(stateDir, "auth");
  const { state, saveCreds } = await usePrivateMultiFileAuthState(authDir);

  if (state.creds.registered) {
    console.log("This WhatsApp account is already paired.");
    return;
  }

  const socket = makeWASocket({
    auth: state,
    browser: ["Muse WhatsApp Bridge", "Chrome", "1.0.0"],
    logger: createBaileysLogger(),
    printQRInTerminal: false,
  });

  socket.ev.on("creds.update", saveCreds);

  let pairingRequested = false;

  async function requestPairingCodeOnce(): Promise<void> {
    if (pairingRequested || state.creds.registered) {
      return;
    }
    pairingRequested = true;

    try {
      const code = await socket.requestPairingCode(normalizedPhone);
      console.log(`Pairing code: ${code}`);
      console.log(
        "Open WhatsApp > Linked Devices > Link with phone number and enter the code."
      );
    } catch (error) {
      console.error(
        `Could not get a pairing code: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      process.exit(1);
    }
  }

  socket.ev.on("connection.update", (update) => {
    if (update.connection === "open") {
      console.log("WhatsApp linked.");
      setTimeout(() => process.exit(0), 1000);
    }

    if (update.connection === "close") {
      const statusCode = (
        update.lastDisconnect?.error as
          | { output?: { statusCode?: number } }
          | undefined
      )?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error("WhatsApp rejected the link (logged out).");
        process.exit(1);
      }
    }
  });

  // Request the pairing code shortly after the socket is created, once the
  // WebSocket handshake has settled. Requesting it synchronously after
  // makeWASocket (or on the first "connecting" event) races the handshake and
  // fails with "Connection Closed".
  setTimeout(() => {
    void requestPairingCodeOnce();
  }, 3000);

  const timeout = setTimeout(() => {
    console.error("Pairing timed out after 5 minutes.");
    process.exit(1);
  }, 300_000);
  timeout.unref();
}

if (import.meta.main) {
  runPair().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
