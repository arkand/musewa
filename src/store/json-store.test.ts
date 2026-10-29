import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-store";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-json-"));
  directories.push(directory);
  return directory;
}

describe("json store", () => {
  test("returns null for a missing file", async () => {
    const directory = await tempDirectory();
    const result = await readJsonFile(
      join(directory, "missing.json"),
      z.object({ ok: z.boolean() })
    );

    expect(result).toBeNull();
  });

  test("writes and reads JSON with a private file mode", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "data.json");

    await writeJsonFile(path, { ok: true });

    expect(await readJsonFile(path, z.object({ ok: z.boolean() }))).toEqual({
      ok: true,
    });
    expect(await readFile(path, "utf8")).toContain('"ok": true');
  });

  test("throws on invalid JSON", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "data.json");
    await writeJsonFile(path, "{invalid");

    await expect(
      readJsonFile(path, z.object({ ok: z.boolean() }))
    ).rejects.toThrow();
  });
});
