import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadStateConfig } from "./config";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-config-"));
  directories.push(directory);
  return directory;
}

const baseEnv = {
  MUSE_BASE_URL: "http://127.0.0.1:8080/v1/",
  MUSE_MODEL: "muse-1",
};

describe("loadConfig", () => {
  test("loads required values and defaults", async () => {
    const config = await loadConfig(baseEnv);

    expect(config.museBaseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(config.museApiKey).toBeUndefined();
    expect(config.museModel).toBe("muse-1");
    expect(config.stateDir).toBe("/var/lib/muse-whatsapp");
    expect(config.groupRequireMention).toBe(true);
    expect(config.historyMaxTurns).toBe(20);
    expect(config.requestTimeoutMs).toBe(120_000);
  });

  test("reads the persona file", async () => {
    const directory = await tempDirectory();
    const personaPath = join(directory, "persona.md");
    await writeFile(personaPath, "You are Muse.\n");

    const config = await loadConfig({
      ...baseEnv,
      MUSE_SYSTEM_PROMPT_FILE: personaPath,
    });

    expect(config.museSystemPrompt).toBe("You are Muse.");
  });

  test("rejects a missing model", async () => {
    await expect(
      loadConfig({ MUSE_BASE_URL: "http://127.0.0.1:8080/v1" })
    ).rejects.toThrow("MUSE_MODEL");
  });

  test("rejects a missing persona file", async () => {
    await expect(
      loadConfig({
        ...baseEnv,
        MUSE_SYSTEM_PROMPT_FILE: "/does/not/exist.md",
      })
    ).rejects.toThrow("Cannot read MUSE_SYSTEM_PROMPT_FILE");
  });

  test("parses GROUP_REQUIRE_MENTION=false", async () => {
    const config = await loadConfig({
      ...baseEnv,
      GROUP_REQUIRE_MENTION: "false",
    });

    expect(config.groupRequireMention).toBe(false);
  });
});

describe("loadStateConfig", () => {
  test("loads the state directory and phone number", () => {
    const config = loadStateConfig({
      STATE_DIR: "/tmp/muse-state",
      WHATSAPP_PHONE_NUMBER: "+628123456789",
    });

    expect(config.stateDir).toBe("/tmp/muse-state");
    expect(config.whatsappPhoneNumber).toBe("+628123456789");
  });
});
