// Adapted from Nakama (MIT). See LICENSE.nakama.
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_UMASK = 0o077;

export async function usePrivateMultiFileAuthState(directory: string) {
  if (process.platform !== "win32") {
    // The bridge is a dedicated process whose only child starts before auth setup.
    // Keep this mask in place for every later Baileys credential and key creation.
    // biome-ignore lint/suspicious/noBitwiseOperators: preserve stricter existing process restrictions.
    process.umask(process.umask() | PRIVATE_UMASK);
  }

  await mkdir(directory, { mode: PRIVATE_DIR_MODE, recursive: true });
  await chmod(directory, PRIVATE_DIR_MODE);

  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      await chmod(join(directory, entry.name), PRIVATE_FILE_MODE);
    }
  }

  return useMultiFileAuthState(directory);
}
