import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDm,
  addGroup,
  addGroupMember,
  AllowlistStore,
  type AllowlistFile,
  isDmAllowed,
  isGroupConfigured,
  isGroupSenderAllowed,
  normalizeAllowEntry,
  normalizeGroupJid,
  removeDm,
  removeGroup,
  removeGroupMember,
} from "./allowlist";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-allowlist-"));
  directories.push(directory);
  return directory;
}

const empty: AllowlistFile = { dm: [], groups: {} };

describe("allowlist normalization", () => {
  test("normalizes phone numbers and JIDs", () => {
    expect(normalizeAllowEntry("+62 812-3456-7890")).toBe(
      "6281234567890@s.whatsapp.net"
    );
    expect(normalizeAllowEntry("6281234567890:12@s.whatsapp.net")).toBe(
      "6281234567890@s.whatsapp.net"
    );
    expect(normalizeAllowEntry("104784384290844:3@lid")).toBe(
      "104784384290844@lid"
    );
  });

  test("rejects a group JID without @g.us", () => {
    expect(() => normalizeGroupJid("6281234567890@s.whatsapp.net")).toThrow(
      "Group JID must end with @g.us"
    );
  });
});

describe("allowlist policy", () => {
  test("allows a DM by any sender identity", () => {
    const allowlist: AllowlistFile = {
      dm: ["6281234567890@s.whatsapp.net"],
      groups: {},
    };

    expect(
      isDmAllowed(allowlist, [
        "104784384290844@lid",
        "6281234567890@s.whatsapp.net",
      ])
    ).toBe(true);
    expect(isDmAllowed(allowlist, ["999@s.whatsapp.net"])).toBe(false);
  });

  test("allows a configured group only when allowAll or member matches", () => {
    const groupJid = "120363000000000000@g.us";
    const allowlist: AllowlistFile = {
      dm: [],
      groups: {
        [groupJid]: { allowAll: false, members: ["6281234567890@s.whatsapp.net"] },
      },
    };

    expect(isGroupConfigured(allowlist, groupJid)).toBe(true);
    expect(
      isGroupSenderAllowed(allowlist, groupJid, ["6281234567890@s.whatsapp.net"])
    ).toBe(true);
    expect(
      isGroupSenderAllowed(allowlist, groupJid, ["999@s.whatsapp.net"])
    ).toBe(false);
    expect(isGroupConfigured(allowlist, "120363999@g.us")).toBe(false);
  });

  test("allowAll permits every member", () => {
    const groupJid = "120363000000000000@g.us";
    const allowlist: AllowlistFile = {
      dm: [],
      groups: { [groupJid]: { allowAll: true, members: [] } },
    };

    expect(isGroupSenderAllowed(allowlist, groupJid, ["999@s.whatsapp.net"])).toBe(
      true
    );
  });
});

describe("allowlist mutations", () => {
  test("adds and removes DM entries without duplicates", () => {
    const first = addDm(empty, "+6281234567890");
    const second = addDm(first, "6281234567890");
    const removed = removeDm(second, "+6281234567890");

    expect(first.dm).toEqual(["6281234567890@s.whatsapp.net"]);
    expect(second.dm).toEqual(["6281234567890@s.whatsapp.net"]);
    expect(removed.dm).toEqual([]);
  });

  test("adds and removes groups and members", () => {
    const groupJid = "120363000000000000@g.us";
    const withGroup = addGroup(empty, groupJid);
    const withMember = addGroupMember(withGroup, groupJid, "+6281234567890");
    const withoutMember = removeGroupMember(withMember, groupJid, "+6281234567890");
    const withoutGroup = removeGroup(withoutMember, groupJid);

    expect(withGroup.groups[groupJid]).toEqual({ allowAll: false, members: [] });
    expect(withMember.groups[groupJid]?.members).toEqual([
      "6281234567890@s.whatsapp.net",
    ]);
    expect(withoutMember.groups[groupJid]?.members).toEqual([]);
    expect(withoutGroup.groups[groupJid]).toBeUndefined();
  });
});

describe("AllowlistStore", () => {
  test("loads and refreshes after the file changes", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "allowlist.json");
    await writeFile(path, JSON.stringify({ dm: [], groups: {} }));
    await utimes(path, new Date(1), new Date(1));

    const store = new AllowlistStore(path);
    expect((await store.load()).dm).toEqual([]);

    await writeFile(
      path,
      JSON.stringify({ dm: ["6281234567890@s.whatsapp.net"], groups: {} })
    );
    await utimes(path, new Date(2), new Date(2));

    expect((await store.refresh()).dm).toEqual([
      "6281234567890@s.whatsapp.net",
    ]);
  });

  test("keeps the last good copy when the file is invalid", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "allowlist.json");
    await writeFile(path, JSON.stringify({ dm: [], groups: {} }));
    await utimes(path, new Date(1), new Date(1));

    const store = new AllowlistStore(path);
    await store.load();

    await writeFile(path, "{invalid");
    await utimes(path, new Date(2), new Date(2));

    expect((await store.refresh()).dm).toEqual([]);
  });

  test("starts denied when the initial file is invalid", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "allowlist.json");
    await writeFile(path, "{invalid");
    await utimes(path, new Date(1), new Date(1));

    const store = new AllowlistStore(path);

    expect((await store.load()).dm).toEqual([]);
    expect((await store.refresh()).dm).toEqual([]);
  });
});
