import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "./history";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-history-"));
  directories.push(directory);
  return directory;
}

describe("HistoryStore", () => {
  test("caps history at twice the turn limit", async () => {
    const directory = await tempDirectory();
    const history = new HistoryStore(join(directory, "history.json"), 2);

    await history.load();

    await Promise.all(
      ["one", "two", "three", "four", "five"].map((content) =>
        history.append("chat", { content, role: "user" })
      )
    );

    expect(history.get("chat")).toEqual([
      { content: "two", role: "user" },
      { content: "three", role: "user" },
      { content: "four", role: "user" },
      { content: "five", role: "user" },
    ]);
  });

  test("persists and reloads history", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "history.json");
    const first = new HistoryStore(path, 20);

    await first.load();
    await first.append("chat", { content: "hello", role: "user" });
    await first.append("chat", { content: "hi", role: "assistant" });

    const second = new HistoryStore(path, 20);
    await second.load();

    expect(second.get("chat")).toEqual([
      { content: "hello", role: "user" },
      { content: "hi", role: "assistant" },
    ]);
  });

  test("serializes concurrent appends without losing messages", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "history.json");
    const history = new HistoryStore(path, 20);

    await history.load();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        history.append("chat", { content: `m${index}`, role: "user" })
      )
    );

    const reloaded = new HistoryStore(path, 20);
    await reloaded.load();

    expect(reloaded.get("chat")).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        content: `m${index}`,
        role: "user",
      }))
    );
  });

  test("prunes conversations older than 30 days on load", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "history.json");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    await writeFile(
      path,
      JSON.stringify({
        conversations: {
          old: { messages: [{ content: "old", role: "user" }], updatedAt: old },
        },
      })
    );

    const history = new HistoryStore(path, 20);
    await history.load();

    expect(history.get("old")).toEqual([]);
  });
});
