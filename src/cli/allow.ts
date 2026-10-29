import { join } from "node:path";
import {
  type AllowlistFile,
  addDm,
  addGroup,
  addGroupMember,
  allowlistSchema,
  removeDm,
  removeGroup,
  removeGroupMember,
} from "../access/allowlist";
import { loadStateConfig } from "../config";
import { readJsonFile, writeJsonFile } from "../store/json-store";

const USAGE = `Usage: allow <command>

  allow dm add <phone>
  allow dm remove <phone>
  allow group add <group-jid>
  allow group remove <group-jid>
  allow group member add <group-jid> <phone>
  allow group member remove <group-jid> <phone>`;

export function applyAllowCommand(
  current: AllowlistFile,
  argv: string[]
): AllowlistFile {
  const [scope, action, target, groupJid, phone] = argv;

  if (scope === "dm" && action === "add" && target) {
    return addDm(current, target);
  }

  if (scope === "dm" && action === "remove" && target) {
    return removeDm(current, target);
  }

  if (scope === "group" && action === "add" && target) {
    return addGroup(current, target);
  }

  if (scope === "group" && action === "remove" && target) {
    return removeGroup(current, target);
  }

  if (
    scope === "group" &&
    action === "member" &&
    target === "add" &&
    groupJid &&
    phone
  ) {
    return addGroupMember(current, groupJid, phone);
  }

  if (
    scope === "group" &&
    action === "member" &&
    target === "remove" &&
    groupJid &&
    phone
  ) {
    return removeGroupMember(current, groupJid, phone);
  }

  throw new Error(USAGE);
}

export async function runAllow(argv = process.argv.slice(2)): Promise<void> {
  const { stateDir } = loadStateConfig();
  const path = join(stateDir, "allowlist.json");
  const current = (await readJsonFile(path, allowlistSchema)) ?? {
    dm: [],
    groups: {},
  };
  const next = applyAllowCommand(current, argv);

  await writeJsonFile(path, next);
  console.log(JSON.stringify(next, null, 2));
}

if (import.meta.main) {
  runAllow().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
