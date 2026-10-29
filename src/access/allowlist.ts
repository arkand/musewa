import { stat } from "node:fs/promises";
import { z } from "zod";
import { readJsonFile } from "../store/json-store";

const groupPolicySchema = z.object({
  allowAll: z.boolean().default(false),
  members: z.array(z.string()).default([]),
});

export const allowlistSchema = z.object({
  dm: z.array(z.string()).default([]),
  groups: z.record(z.string(), groupPolicySchema).default({}),
});

export type GroupPolicy = z.infer<typeof groupPolicySchema>;
export type AllowlistFile = z.infer<typeof allowlistSchema>;

export function normalizeJid(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Empty WhatsApp identity");
  }

  if (trimmed.includes("@")) {
    const [user = "", server = ""] = trimmed.split("@");
    const normalizedUser = user.split(":")[0] ?? user;
    return `${normalizedUser}@${server}`;
  }

  return normalizePhoneToJid(trimmed);
}

export function normalizePhoneToJid(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (!/^\d{6,15}$/.test(digits)) {
    throw new Error(`Invalid phone number: ${value}`);
  }

  return `${digits}@s.whatsapp.net`;
}

export function normalizeAllowEntry(value: string): string {
  return value.includes("@") ? normalizeJid(value) : normalizePhoneToJid(value);
}

export function normalizeGroupJid(value: string): string {
  const jid = normalizeJid(value);

  if (!jid.endsWith("@g.us")) {
    throw new Error("Group JID must end with @g.us");
  }

  return jid;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function isDmAllowed(
  allowlist: AllowlistFile,
  senderJids: readonly string[]
): boolean {
  const allowed = new Set(allowlist.dm.map(normalizeJid));

  return senderJids.some((jid) => allowed.has(normalizeJid(jid)));
}

export function isGroupConfigured(
  allowlist: AllowlistFile,
  groupJid: string
): boolean {
  return Boolean(allowlist.groups[normalizeGroupJid(groupJid)]);
}

export function isGroupSenderAllowed(
  allowlist: AllowlistFile,
  groupJid: string,
  senderJids: readonly string[]
): boolean {
  const policy = allowlist.groups[normalizeGroupJid(groupJid)];

  if (!policy) {
    return false;
  }

  if (policy.allowAll) {
    return true;
  }

  const members = new Set(policy.members.map(normalizeJid));

  return senderJids.some((jid) => members.has(normalizeJid(jid)));
}

export function addDm(allowlist: AllowlistFile, entry: string): AllowlistFile {
  return {
    ...allowlist,
    dm: uniqueSorted([...allowlist.dm, normalizeAllowEntry(entry)]),
  };
}

export function removeDm(
  allowlist: AllowlistFile,
  entry: string
): AllowlistFile {
  const jid = normalizeAllowEntry(entry);

  return {
    ...allowlist,
    dm: allowlist.dm.filter((item) => normalizeJid(item) !== jid),
  };
}

export function addGroup(
  allowlist: AllowlistFile,
  groupJid: string
): AllowlistFile {
  const jid = normalizeGroupJid(groupJid);

  return {
    ...allowlist,
    groups: {
      ...allowlist.groups,
      [jid]: allowlist.groups[jid] ?? { allowAll: false, members: [] },
    },
  };
}

export function removeGroup(
  allowlist: AllowlistFile,
  groupJid: string
): AllowlistFile {
  const jid = normalizeGroupJid(groupJid);
  const groups = { ...allowlist.groups };
  delete groups[jid];

  return { ...allowlist, groups };
}

export function addGroupMember(
  allowlist: AllowlistFile,
  groupJid: string,
  entry: string
): AllowlistFile {
  const jid = normalizeGroupJid(groupJid);
  const policy = allowlist.groups[jid] ?? { allowAll: false, members: [] };

  return {
    ...allowlist,
    groups: {
      ...allowlist.groups,
      [jid]: {
        ...policy,
        members: uniqueSorted([...policy.members, normalizeAllowEntry(entry)]),
      },
    },
  };
}

export function removeGroupMember(
  allowlist: AllowlistFile,
  groupJid: string,
  entry: string
): AllowlistFile {
  const jid = normalizeGroupJid(groupJid);
  const policy = allowlist.groups[jid];

  if (!policy) {
    return allowlist;
  }

  const member = normalizeAllowEntry(entry);

  return {
    ...allowlist,
    groups: {
      ...allowlist.groups,
      [jid]: {
        ...policy,
        members: policy.members.filter((item) => normalizeJid(item) !== member),
      },
    },
  };
}

export class AllowlistStore {
  private readonly path: string;
  private current: AllowlistFile = { dm: [], groups: {} };
  private mtimeMs = 0;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<AllowlistFile> {
    try {
      const loaded = await readJsonFile(this.path, allowlistSchema);

      this.current = loaded ?? { dm: [], groups: {} };
    } catch (error) {
      console.error(
        "Allowlist load failed; denying all senders until the file is fixed.",
        error
      );
      this.current = { dm: [], groups: {} };
    }

    this.mtimeMs = await this.mtime();

    return this.current;
  }

  async refresh(): Promise<AllowlistFile> {
    const mtime = await this.mtime();

    if (mtime === this.mtimeMs) {
      return this.current;
    }

    try {
      const loaded = await readJsonFile(this.path, allowlistSchema);

      this.current = loaded ?? { dm: [], groups: {} };
      this.mtimeMs = mtime;
    } catch (error) {
      console.error(
        "Allowlist reload failed; keeping the last good copy.",
        error
      );
      this.mtimeMs = mtime;
    }

    return this.current;
  }

  get(): AllowlistFile {
    return this.current;
  }

  private async mtime(): Promise<number> {
    try {
      return (await stat(this.path)).mtimeMs;
    } catch {
      return 0;
    }
  }
}
