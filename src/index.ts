import { existsSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "./app";
import { loadConfig } from "./config";
import { installBaileysConsoleRedaction } from "./whatsapp/baileys-logger";
import { registerProcessLifecycleHandlers } from "./whatsapp/process-lifecycle";

async function main(): Promise<void> {
  installBaileysConsoleRedaction();

  const config = await loadConfig();

  if (!existsSync(join(config.stateDir, "auth", "creds.json"))) {
    console.error(
      "WhatsApp is not paired. Run: bun --env-file /etc/muse-whatsapp.env dist/pair.js --phone +<number>"
    );
    process.exit(0);
  }

  const app = await startApp(config, {
    onLoggedOut: () => {
      console.error(
        "WhatsApp logged out. Re-pair the number before starting the service again."
      );
      process.exit(0);
    },
  });

  registerProcessLifecycleHandlers(() => app.stop());

  console.log("Muse WhatsApp bridge is running.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
