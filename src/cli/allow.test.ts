import { describe, expect, test } from "bun:test";
import type { AllowlistFile } from "../access/allowlist";
import { applyAllowCommand } from "./allow";

const empty: AllowlistFile = { dm: [], groups: {} };
const groupJid = "120363000000000000@g.us";

describe("allow CLI", () => {
  test("adds a DM", () => {
    expect(applyAllowCommand(empty, ["dm", "add", "+6281234567890"])).toEqual({
      dm: ["6281234567890@s.whatsapp.net"],
      groups: {},
    });
  });

  test("removes a DM", () => {
    const current: AllowlistFile = {
      dm: ["6281234567890@s.whatsapp.net"],
      groups: {},
    };

    expect(
      applyAllowCommand(current, ["dm", "remove", "+6281234567890"])
    ).toEqual({ dm: [], groups: {} });
  });

  test("adds a group and a member", () => {
    const withGroup = applyAllowCommand(empty, ["group", "add", groupJid]);
    const withMember = applyAllowCommand(withGroup, [
      "group",
      "member",
      "add",
      groupJid,
      "+6281234567890",
    ]);

    expect(withMember.groups[groupJid]?.members).toEqual([
      "6281234567890@s.whatsapp.net",
    ]);
  });

  test("removes a member and a group", () => {
    const current: AllowlistFile = {
      dm: [],
      groups: {
        [groupJid]: {
          allowAll: false,
          members: ["6281234567890@s.whatsapp.net"],
        },
      },
    };
    const withoutMember = applyAllowCommand(current, [
      "group",
      "member",
      "remove",
      groupJid,
      "+6281234567890",
    ]);
    const withoutGroup = applyAllowCommand(withoutMember, [
      "group",
      "remove",
      groupJid,
    ]);

    expect(withoutMember.groups[groupJid]?.members).toEqual([]);
    expect(withoutGroup.groups[groupJid]).toBeUndefined();
  });

  test("rejects an unknown command", () => {
    expect(() => applyAllowCommand(empty, ["nope"])).toThrow("Usage: allow");
  });

  test("rejects a group member command without a phone", () => {
    expect(() =>
      applyAllowCommand(empty, ["group", "member", "add", groupJid])
    ).toThrow("Usage: allow");
  });
});
