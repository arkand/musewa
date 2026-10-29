# Muse WhatsApp Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone WhatsApp bridge that connects one WhatsApp number to an external OpenAI-compatible Muse agent and runs on the Muse VM under systemd.

**Architecture:** Bun/TypeScript service. Baileys owns the WhatsApp linked-device connection. A handler applies allowlist and group-mention policy, stores capped per-conversation history, calls Muse at `POST /v1/chat/completions`, and sends the reply back. No Nakama server is used.

**Tech Stack:** Bun 1.4+, TypeScript, `@whiskeysockets/baileys` 7.0.0-rc14, zod 4, systemd.

**Spec:** `docs/superpowers/specs/2026-10-29-muse-whatsapp-bridge-design.md`

## Global Constraints

- Bun 1.4+; the runtime is Bun, not Node.
- Text only. Drop images, documents, audio, stickers, and reactions.
- Deny by default. An unknown sender gets no reply.
- `MUSE_BASE_URL` points to a local OpenAI-compatible API. Do not hardcode a URL or model.
- `MUSE_API_KEY` is optional. Send it as `Authorization: Bearer <key>` only when set.
- `STATE_DIR` defaults to `/var/lib/muse-whatsapp`.
- `GROUP_REQUIRE_MENTION` defaults to `true`.
- `HISTORY_MAX_TURNS` defaults to `20`; keep at most `2 * HISTORY_MAX_TURNS` messages.
- `REQUEST_TIMEOUT_MS` defaults to `120000`.
- Inbound text cap: 16 KiB.
- Per-sender rate limit: 20 messages per minute.
- Deduplicate message IDs for 2 minutes.
- Do not log message text. Log masked JIDs only.
- Copied Nakama files keep the header `Adapted from Nakama (MIT). See LICENSE.nakama.`
- Do not commit, amend, push, or open a PR unless the user explicitly asks. Every "Commit" step below is optional for that reason.
- Tests use `bun test`. Type check uses `bun x tsc --noEmit`. Lint uses `bun x ultracite check`.

---

## File Structure

```
src/
  index.ts                 process entry, unpaired guard, lifecycle
  app.ts                   dependency wiring and start/stop
  config.ts                env validation and persona loading
  store/json-store.ts      atomic JSON read/write
  access/allowlist.ts      allowlist schema, matching, mutations, hot reload
  muse/history.ts          capped per-conversation history
  muse/client.ts           OpenAI-compatible chat client
  bridge/guards.ts         dedup cache and rate limiter
  bridge/handler.ts        policy gate, history, Muse call, reply
  whatsapp/
    auth-state.ts          copied: private multi-file auth
    baileys-logger.ts      copied: quiet Baileys logger
    group-message.ts       ported: mention rules
    format.ts              ported: Markdown strip and split
    inbound-message.ts     copied: text extraction and echo suppression
    log-metadata.ts        copied: JID masking
    process-lifecycle.ts   copied: signal handling
    socket.ts              ported: Baileys connection and reconnect
  cli/
    pair.ts                headless pairing code
    allow.ts               allowlist commands
deploy/
  muse-whatsapp.service    systemd unit
.env.example
.gitignore
LICENSE.nakama
README.md
biome.jsonc
package.json
tsconfig.json
```

| File | Responsibility |
|---|---|
| `src/config.ts` | Read and validate env. Load the optional persona file. |
| `src/store/json-store.ts` | Read JSON with a zod schema. Write atomically with `0600`. |
| `src/access/allowlist.ts` | Normalize JIDs, match DM/group policy, mutate the file, reload on mtime. |
| `src/muse/history.ts` | Keep and persist capped conversation history. |
| `src/muse/client.ts` | Call Muse. Map failures to `MuseError`. |
| `src/bridge/guards.ts` | Deduplicate message IDs. Limit per-sender rate. |
| `src/bridge/handler.ts` | Apply policy. Call Muse. Send replies. |
| `src/app.ts` | Build the real dependencies and connect the socket. |
| `src/index.ts` | Load config, refuse to start unpaired, register signals. |
| `src/whatsapp/socket.ts` | Own Baileys reconnect, message events, and echo suppression. |
| `src/cli/pair.ts` | Request a pairing code and save credentials. |
| `src/cli/allow.ts` | Edit `allowlist.json` from the VM. |

Each file has one purpose. Tests live next to the file as `*.test.ts`.

---

### Task 1: Scaffold and config loader

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `biome.jsonc`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `LICENSE.nakama`
- Create: `src/config.ts`
- Create: `src/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: Record<string, string | undefined>): Promise<BridgeConfig>`
- Produces: `loadStateConfig(env?: Record<string, string | undefined>): StateConfig`
- Produces: `BridgeConfig` with fields `museBaseUrl`, `museApiKey?`, `museModel`, `museSystemPrompt?`, `stateDir`, `whatsappPhoneNumber?`, `groupRequireMention`, `historyMaxTurns`, `requestTimeoutMs`.
- Produces: `StateConfig` with fields `stateDir`, `whatsappPhoneNumber?`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "muse-whatsapp-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run src/index.ts",
    "start": "bun run dist/index.js",
    "build": "bun build src/index.ts --outdir dist --target bun --external @whiskeysockets/baileys && bun build src/cli/pair.ts --outdir dist --target bun --external @whiskeysockets/baileys && bun build src/cli/allow.ts --outdir dist --target bun --external @whiskeysockets/baileys",
    "test": "bun test",
    "typecheck": "bun x tsc --noEmit",
    "lint": "bun x ultracite check",
    "pair": "bun run src/cli/pair.ts",
    "allow": "bun run src/cli/allow.ts"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "7.0.0-rc14",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.14",
    "@types/bun": "^1.4.2",
    "typescript": "^5.8.3",
    "ultracite": "7.11.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "allowSyntheticDefaultImports": true,
    "types": ["bun"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `biome.jsonc`**

```jsonc
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "extends": ["ultracite/biome/core"],
  "javascript": {
    "globals": ["Bun"]
  },
  "linter": {
    "rules": {
      "complexity": {
        "noExcessiveCognitiveComplexity": "off",
        "noForEach": "off",
        "useOptionalChain": "off"
      },
      "performance": {
        "useTopLevelRegex": "off"
      },
      "style": {
        "noExportedImports": "off",
        "noIncrementDecrement": "off",
        "noNestedTernary": "off",
        "noNonNullAssertion": "off",
        "noParameterProperties": "off",
        "useAtIndex": "off",
        "useConsistentArrayType": "off",
        "useConsistentBuiltinInstantiation": "off",
        "useConsistentMemberAccessibility": "off",
        "useConsistentMethodSignatures": "off",
        "useConsistentTypeDefinitions": "off",
        "useDefaultParameterLast": "off",
        "useDefaultSwitchClause": "off"
      },
      "suspicious": {
        "noExplicitAny": "off",
        "useAwait": "off"
      }
    }
  }
}
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
dist/
.env
*.log
coverage/
```

- [ ] **Step 5: Write `.env.example`**

```dotenv
MUSE_BASE_URL=http://127.0.0.1:8080/v1
MUSE_API_KEY=
MUSE_MODEL=muse-model-name
MUSE_SYSTEM_PROMPT_FILE=/etc/muse-persona.md
STATE_DIR=/var/lib/muse-whatsapp
WHATSAPP_PHONE_NUMBER=+628123456789
GROUP_REQUIRE_MENTION=true
HISTORY_MAX_TURNS=20
REQUEST_TIMEOUT_MS=120000
```

- [ ] **Step 6: Copy the Nakama license notice**

Run:

```bash
cp /home/arkan/projects/nakama/LICENSE /home/arkan/projects/muse-whatsapp-bridge/LICENSE.nakama
```

- [ ] **Step 7: Write the failing config test**

Write `src/config.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadStateConfig } from "./config";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
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
```

- [ ] **Step 8: Run the test and verify it fails**

Run: `bun test src/config.test.ts`

Expected: FAIL because `./config` does not exist.

- [ ] **Step 9: Write `src/config.ts`**

```ts
import { readFile } from "node:fs/promises";
import { z } from "zod";

const urlSchema = z.string().trim().refine((value) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}, { message: "Must be a valid URL" });

const baseSchema = z.object({
  MUSE_BASE_URL: urlSchema,
  MUSE_API_KEY: z.string().trim().optional(),
  MUSE_MODEL: z.string().trim().min(1),
  MUSE_SYSTEM_PROMPT_FILE: z.string().trim().optional(),
  STATE_DIR: z.string().trim().default("/var/lib/muse-whatsapp"),
  WHATSAPP_PHONE_NUMBER: z.string().trim().optional(),
  GROUP_REQUIRE_MENTION: z.enum(["true", "false"]).default("true"),
  HISTORY_MAX_TURNS: z.coerce.number().int().positive().default(20),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

const stateSchema = z.object({
  STATE_DIR: z.string().trim().default("/var/lib/muse-whatsapp"),
  WHATSAPP_PHONE_NUMBER: z.string().trim().optional(),
});

export interface BridgeConfig {
  museBaseUrl: string;
  museApiKey?: string;
  museModel: string;
  museSystemPrompt?: string;
  stateDir: string;
  whatsappPhoneNumber?: string;
  groupRequireMention: boolean;
  historyMaxTurns: number;
  requestTimeoutMs: number;
}

export interface StateConfig {
  stateDir: string;
  whatsappPhoneNumber?: string;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

export function baseUrlWithoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function loadConfig(
  env: Record<string, string | undefined> = process.env
): Promise<BridgeConfig> {
  const parsed = baseSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${formatIssues(parsed.error)}`);
  }

  const value = parsed.data;
  let museSystemPrompt: string | undefined;

  if (value.MUSE_SYSTEM_PROMPT_FILE) {
    try {
      museSystemPrompt =
        (await readFile(value.MUSE_SYSTEM_PROMPT_FILE, "utf8")).trim() ||
        undefined;
    } catch (cause) {
      throw new Error(
        `Cannot read MUSE_SYSTEM_PROMPT_FILE at ${value.MUSE_SYSTEM_PROMPT_FILE}`,
        { cause }
      );
    }
  }

  return {
    museBaseUrl: baseUrlWithoutTrailingSlash(value.MUSE_BASE_URL),
    museApiKey: value.MUSE_API_KEY || undefined,
    museModel: value.MUSE_MODEL,
    museSystemPrompt,
    stateDir: value.STATE_DIR,
    whatsappPhoneNumber: value.WHATSAPP_PHONE_NUMBER || undefined,
    groupRequireMention: value.GROUP_REQUIRE_MENTION === "true",
    historyMaxTurns: value.HISTORY_MAX_TURNS,
    requestTimeoutMs: value.REQUEST_TIMEOUT_MS,
  };
}

export function loadStateConfig(
  env: Record<string, string | undefined> = process.env
): StateConfig {
  const parsed = stateSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${formatIssues(parsed.error)}`);
  }

  return {
    stateDir: parsed.data.STATE_DIR,
    whatsappPhoneNumber: parsed.data.WHATSAPP_PHONE_NUMBER || undefined,
  };
}
```

- [ ] **Step 10: Install dependencies and run the test**

Run:

```bash
bun install
bun test src/config.test.ts
```

Expected: PASS.

- [ ] **Step 11: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass with no errors.

- [ ] **Step 12: Commit (only if the user asked for commits)**

```bash
git init
git add package.json bun.lock tsconfig.json biome.jsonc .gitignore .env.example LICENSE.nakama src/config.ts src/config.test.ts
git commit -m "chore: scaffold Muse WhatsApp bridge and config"
```

---

### Task 2: JSON store and allowlist

**Files:**
- Create: `src/store/json-store.ts`
- Create: `src/store/json-store.test.ts`
- Create: `src/access/allowlist.ts`
- Create: `src/access/allowlist.test.ts`

**Interfaces:**
- Produces: `readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T | null>`
- Produces: `writeJsonFile(path: string, value: unknown): Promise<void>`
- Produces: `AllowlistFile` with `dm: string[]` and `groups: Record<string, GroupPolicy>`.
- Produces: `GroupPolicy` with `allowAll: boolean` and `members: string[]`.
- Produces: `normalizeAllowEntry(value: string): string`
- Produces: `normalizeJid(value: string): string`
- Produces: `normalizePhoneToJid(value: string): string`
- Produces: `normalizeGroupJid(value: string): string`
- Produces: `isDmAllowed(allowlist, senderJids): boolean`
- Produces: `isGroupConfigured(allowlist, groupJid): boolean`
- Produces: `isGroupSenderAllowed(allowlist, groupJid, senderJids): boolean`
- Produces: `addDm`, `removeDm`, `addGroup`, `removeGroup`, `addGroupMember`, `removeGroupMember`.
- Produces: `AllowlistStore` with `load()`, `refresh()`, `get()`.

- [ ] **Step 1: Write the failing JSON store test**

Write `src/store/json-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/store/json-store.test.ts`

Expected: FAIL because `./json-store` does not exist.

- [ ] **Step 3: Write `src/store/json-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }

    throw error;
  }

  return schema.parse(JSON.parse(raw));
}

export async function writeJsonFile(
  path: string,
  value: unknown
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${process.pid}.${randomUUID()}.tmp`
  );

  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}
```

- [ ] **Step 4: Write the failing allowlist test**

Write `src/access/allowlist.test.ts`:

```ts
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
```

- [ ] **Step 5: Run the test and verify it fails**

Run: `bun test src/access/allowlist.test.ts`

Expected: FAIL because `./allowlist` does not exist.

- [ ] **Step 6: Write `src/access/allowlist.ts`**

```ts
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

export function addDm(
  allowlist: AllowlistFile,
  entry: string
): AllowlistFile {
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
        members: policy.members.filter(
          (item) => normalizeJid(item) !== member
        ),
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
      console.error("Allowlist reload failed; keeping the last good copy.", error);
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
```

- [ ] **Step 7: Run the tests**

Run:

```bash
bun test src/store/json-store.test.ts src/access/allowlist.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 9: Commit (only if the user asked for commits)**

```bash
git add src/store src/access
git commit -m "feat: add JSON store and allowlist policy"
```

---

### Task 3: Conversation history

**Files:**
- Create: `src/muse/history.ts`
- Create: `src/muse/history.test.ts`

**Interfaces:**
- Produces: `ChatMessage` with `role: "user" | "assistant"` and `content: string`.
- Produces: `HistoryStore` with `load()`, `get(key)`, `append(key, message)`, and `prune()`.

- [ ] **Step 1: Write the failing test**

Write `src/muse/history.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "./history";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
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

    for (const content of ["one", "two", "three", "four", "five"]) {
      await history.append("chat", { role: "user", content });
    }

    expect(history.get("chat")).toEqual([
      { role: "user", content: "two" },
      { role: "user", content: "three" },
      { role: "user", content: "four" },
      { role: "user", content: "five" },
    ]);
  });

  test("persists and reloads history", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "history.json");
    const first = new HistoryStore(path, 20);

    await first.load();
    await first.append("chat", { role: "user", content: "hello" });
    await first.append("chat", { role: "assistant", content: "hi" });

    const second = new HistoryStore(path, 20);
    await second.load();

    expect(second.get("chat")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("serializes concurrent appends without losing messages", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "history.json");
    const history = new HistoryStore(path, 20);

    await history.load();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        history.append("chat", { role: "user", content: `m${index}` })
      )
    );

    const reloaded = new HistoryStore(path, 20);
    await reloaded.load();

    expect(reloaded.get("chat")).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        role: "user",
        content: `m${index}`,
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
          old: { updatedAt: old, messages: [{ role: "user", content: "old" }] },
        },
      })
    );

    const history = new HistoryStore(path, 20);
    await history.load();

    expect(history.get("old")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/muse/history.test.ts`

Expected: FAIL because `./history` does not exist.

- [ ] **Step 3: Write `src/muse/history.ts`**

```ts
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../store/json-store";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const conversationSchema = z.object({
  updatedAt: z.string(),
  messages: z.array(chatMessageSchema),
});

const historySchema = z.object({
  conversations: z.record(z.string(), conversationSchema).default({}),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class HistoryStore {
  private readonly path: string;
  private readonly maxTurns: number;
  private readonly now: () => number;
  private data: z.infer<typeof historySchema> = { conversations: {} };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    maxTurns: number,
    now: () => number = () => Date.now()
  ) {
    this.path = path;
    this.maxTurns = maxTurns;
    this.now = now;
  }

  async load(): Promise<void> {
    const loaded = await readJsonFile(this.path, historySchema);

    this.data = loaded ?? { conversations: {} };
    this.prune();
  }

  get(key: string): ChatMessage[] {
    return [...(this.data.conversations[key]?.messages ?? [])];
  }

  async append(key: string, message: ChatMessage): Promise<void> {
    const existing = this.data.conversations[key] ?? {
      updatedAt: new Date(this.now()).toISOString(),
      messages: [],
    };
    const messages = [...existing.messages, message].slice(
      -this.maxTurns * 2
    );

    this.data.conversations[key] = {
      updatedAt: new Date(this.now()).toISOString(),
      messages,
    };

    this.prune();

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await writeJsonFile(this.path, this.data);
      } catch (error) {
        console.error("History write failed; keeping history in memory.", error);
      }
    });

    await this.writeQueue;
  }

  prune(): void {
    const cutoff = this.now() - MAX_AGE_MS;

    for (const [key, conversation] of Object.entries(
      this.data.conversations
    )) {
      if (Date.parse(conversation.updatedAt) < cutoff) {
        delete this.data.conversations[key];
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/muse/history.test.ts`

Expected: PASS.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/muse/history.ts src/muse/history.test.ts
git commit -m "feat: add capped conversation history"
```

---

### Task 4: Muse OpenAI-compatible client

**Files:**
- Create: `src/muse/client.ts`
- Create: `src/muse/client.test.ts`

**Interfaces:**
- Produces: `MuseMessage` with `role: "system" | "user" | "assistant"` and `content: string`.
- Produces: `ChatClient` with `chat(messages: MuseMessage[]): Promise<string>`.
- Produces: `MuseError` with `kind: "http" | "network" | "timeout" | "shape"` and optional `status`.
- Produces: `MuseClient` implementing `ChatClient`.

- [ ] **Step 1: Write the failing test**

Write `src/muse/client.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { MuseClient, MuseError } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MuseClient", () => {
  test("sends the model, messages, and bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ choices: [{ message: { content: " hi " } }] });
    }) as typeof fetch;

    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      apiKey: "secret",
      model: "muse-1",
      timeoutMs: 1000,
      fetchImpl,
    });

    const reply = await client.chat([{ role: "user", content: "hello" }]);

    expect(reply).toBe("hi");
    expect(calls[0]?.url).toBe("http://muse.local/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(
      (calls[0]?.init.headers as Record<string, string>).authorization
    ).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "muse-1",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
  });

  test("omits the authorization header without a key", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit
    ) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;

    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      model: "muse-1",
      timeoutMs: 1000,
      fetchImpl,
    });

    await client.chat([{ role: "user", content: "hello" }]);

    expect(headers.authorization).toBeUndefined();
  });

  test("maps a non-2xx response to an http error", async () => {
    const fetchImpl = (async () =>
      new Response("bad gateway", { status: 502 })) as typeof fetch;
    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      model: "muse-1",
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(
      client.chat([{ role: "user", content: "hello" }])
    ).rejects.toMatchObject({ kind: "http", status: 502 });
  });

  test("maps an empty reply to a shape error", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ choices: [{ message: { content: "   " } }] })) as typeof fetch;
    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      model: "muse-1",
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(
      client.chat([{ role: "user", content: "hello" }])
    ).rejects.toBeInstanceOf(MuseError);
  });

  test("maps invalid JSON to a shape error", async () => {
    const fetchImpl = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      model: "muse-1",
      timeoutMs: 1000,
      fetchImpl,
    });

    await expect(
      client.chat([{ role: "user", content: "hello" }])
    ).rejects.toMatchObject({ kind: "shape" });
  });

  test("maps an abort to a timeout error", async () => {
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit
    ) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      model: "muse-1",
      timeoutMs: 10,
      fetchImpl,
    });

    await expect(
      client.chat([{ role: "user", content: "hello" }])
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/muse/client.test.ts`

Expected: FAIL because `./client` does not exist.

- [ ] **Step 3: Write `src/muse/client.ts`**

```ts
export interface MuseMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatClient {
  chat(messages: MuseMessage[]): Promise<string>;
}

export type MuseErrorKind = "http" | "network" | "timeout" | "shape";

export class MuseError extends Error {
  readonly kind: MuseErrorKind;
  readonly status?: number;

  constructor(message: string, kind: MuseErrorKind, status?: number) {
    super(message);
    this.name = "MuseError";
    this.kind = kind;
    this.status = status;
  }
}

export interface MuseClientOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class MuseClient implements ChatClient {
  private readonly options: MuseClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MuseClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(messages: MuseMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs
    );

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };

      if (this.options.apiKey) {
        headers.authorization = `Bearer ${this.options.apiKey}`;
      }

      const response = await this.fetchImpl(
        `${this.options.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.options.model,
            messages,
            stream: false,
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        throw new MuseError(
          `Muse returned ${response.status}: ${body}`,
          "http",
          response.status
        );
      }

      const payload = await response.json().catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }

        throw new MuseError("Muse returned invalid JSON", "shape");
      }) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;

      if (typeof content !== "string" || !content.trim()) {
        throw new MuseError("Muse returned an empty reply", "shape");
      }

      return content.trim();
    } catch (error) {
      if (error instanceof MuseError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new MuseError("Muse request timed out", "timeout");
      }

      throw new MuseError(
        error instanceof Error ? error.message : String(error),
        "network"
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/muse/client.test.ts`

Expected: PASS.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/muse/client.ts src/muse/client.test.ts
git commit -m "feat: add Muse OpenAI-compatible client"
```

---

### Task 5: Dedup cache and rate limiter

**Files:**
- Create: `src/bridge/guards.ts`
- Create: `src/bridge/guards.test.ts`

**Interfaces:**
- Produces: `MessageDeduper` with `has(id: string | null): boolean` and `remember(id: string | null): void`.
- Produces: `RateLimiter` with `allow(key: string): boolean`.
- Produces: `ConcurrencyLimiter` with `run<T>(task: () => Promise<T>): Promise<T>`.

- [ ] **Step 1: Write the failing test**

Write `src/bridge/guards.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  ConcurrencyLimiter,
  MessageDeduper,
  RateLimiter,
} from "./guards";

describe("MessageDeduper", () => {
  test("remembers an id for the ttl", () => {
    let now = 0;
    const deduper = new MessageDeduper(1000, () => now);

    expect(deduper.has("m1")).toBe(false);
    deduper.remember("m1");
    expect(deduper.has("m1")).toBe(true);

    now = 1001;
    expect(deduper.has("m1")).toBe(false);
  });

  test("ignores a null id", () => {
    const deduper = new MessageDeduper();

    deduper.remember(null);

    expect(deduper.has(null)).toBe(false);
  });
});

describe("RateLimiter", () => {
  test("allows the limit and blocks the next message in the window", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);

    expect(limiter.allow("sender")).toBe(true);
    expect(limiter.allow("sender")).toBe(true);
    expect(limiter.allow("sender")).toBe(false);
    expect(limiter.allow("other")).toBe(true);

    now = 1001;
    expect(limiter.allow("sender")).toBe(true);
  });
});

describe("ConcurrencyLimiter", () => {
  test("caps active tasks and resumes waiters", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };

    await Promise.all(
      Array.from({ length: 5 }, () => limiter.run(task))
    );

    expect(maxActive).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/bridge/guards.test.ts`

Expected: FAIL because `./guards` does not exist.

- [ ] **Step 3: Write `src/bridge/guards.ts`**

```ts
export class MessageDeduper {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    ttlMs: number = 120_000,
    now: () => number = () => Date.now()
  ) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  has(id: string | null): boolean {
    if (!id) {
      return false;
    }

    this.prune();

    return this.seen.has(id);
  }

  remember(id: string | null): void {
    if (!id) {
      return;
    }

    this.prune();
    this.seen.set(id, this.now());
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;

    for (const [id, seenAt] of this.seen) {
      if (seenAt < cutoff) {
        this.seen.delete(id);
      }
    }
  }
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    limit: number = 20,
    windowMs: number = 60_000,
    now: () => number = () => Date.now()
  ) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  allow(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff
    );

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);

    return true;
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number = 4) {
    if (limit < 1) {
      throw new Error("Concurrency limit must be at least 1");
    }

    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();

    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();

    if (next) {
      next();
      return;
    }

    this.active -= 1;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/bridge/guards.test.ts`

Expected: PASS.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/bridge/guards.ts src/bridge/guards.test.ts
git commit -m "feat: add dedup and rate-limit guards"
```

---

### Task 6: WhatsApp text and group helpers

**Files:**
- Create: `src/whatsapp/format.ts`
- Create: `src/whatsapp/format.test.ts`
- Create: `src/whatsapp/group-message.ts`
- Create: `src/whatsapp/group-message.test.ts`

**Interfaces:**
- Produces: `prepareWhatsAppReply(text: string): string`
- Produces: `splitWhatsAppMessage(text: string): string[]`
- Produces: `WhatsAppAccount` with `id: string` and `lid?: string | null`.
- Produces: `explainGroupMessageHandling(input): GroupMessageHandlingDecision`
- Produces: `stripWhatsAppBotMention(text: string): string`

- [ ] **Step 1: Write the failing format test**

Write `src/whatsapp/format.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { prepareWhatsAppReply, splitWhatsAppMessage } from "./format";

describe("WhatsApp formatting", () => {
  test("strips code fences, headings, and backticks", () => {
    const fence = "`".repeat(3);
    const input = [
      `${fence}ts`,
      "const a = 1;",
      fence,
      "# Title",
      "Use `this` now.",
    ].join("\n");

    expect(prepareWhatsAppReply(input)).toBe(
      "const a = 1;\nTitle\nUse this now."
    );
  });

  test("keeps bold and italics in WhatsApp form", () => {
    expect(prepareWhatsAppReply("**bold** and _italic_")).toBe(
      "*bold* and _italic_"
    );
  });

  test("returns one bubble for a short reply", () => {
    expect(splitWhatsAppMessage("hello")).toEqual(["hello"]);
  });

  test("splits a long reply into bubbles near 400 characters", () => {
    const paragraph = "word ".repeat(120).trim();
    const parts = splitWhatsAppMessage(`${paragraph}\n\n${paragraph}`);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 400)).toBe(true);
  });

  test("splits a single huge paragraph", () => {
    const parts = splitWhatsAppMessage("a".repeat(900));

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 400)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/whatsapp/format.test.ts`

Expected: FAIL because `./format` does not exist.

- [ ] **Step 3: Write `src/whatsapp/format.ts`**

```ts
const WHATSAPP_MAX_MESSAGE_LENGTH = 65_536;
const WHATSAPP_CHAT_BUBBLE_MAX_CHARS = 400;

function stripMarkdownForWhatsApp(text: string): string {
  const codeFence = "`".repeat(3);
  let result = text.trim();

  result = result.replace(
    new RegExp(`${codeFence}[\\w]*\\n?([\\s\\S]*?)${codeFence}`, "g"),
    (_, code: string) => code.trim()
  );
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  result = result.replace(/_([^_]+)_/g, "_$1_");

  return result.trim();
}

export function prepareWhatsAppReply(text: string): string {
  return stripMarkdownForWhatsApp(text);
}

export function splitWhatsAppMessage(text: string): string[] {
  if (text.length <= WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
    return splitWhatsAppLongMessage(text);
  }

  const paragraphs = text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const merged: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
      if (current) {
        merged.push(current);
        current = "";
      }

      merged.push(
        ...splitLongParagraph(paragraph, WHATSAPP_CHAT_BUBBLE_MAX_CHARS)
      );
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
      current = candidate;
      continue;
    }

    if (current) {
      merged.push(current);
    }

    current = paragraph;
  }

  if (current) {
    merged.push(current);
  }

  return merged.flatMap((bubble) => splitWhatsAppLongMessage(bubble));
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = paragraph;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(" ", maxChars);

    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function splitWhatsAppLongMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > WHATSAPP_MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", WHATSAPP_MAX_MESSAGE_LENGTH);

    if (splitAt <= 0) {
      splitAt = WHATSAPP_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
```

- [ ] **Step 4: Write the failing group test**

Write `src/whatsapp/group-message.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  explainGroupMessageHandling,
  isWhatsAppBotAddress,
  isWhatsAppGroupChat,
  stripWhatsAppBotMention,
  type WhatsAppAccount,
} from "./group-message";

const me: WhatsAppAccount = {
  id: "628100000000@s.whatsapp.net",
  lid: "236283431522503@lid",
};

describe("group-message helpers", () => {
  test("detects group JIDs", () => {
    expect(isWhatsAppGroupChat("120363@g.us")).toBe(true);
    expect(isWhatsAppGroupChat("628100000000@s.whatsapp.net")).toBe(false);
  });

  test("matches bot phone and lid identities", () => {
    expect(isWhatsAppBotAddress("628100000000@s.whatsapp.net", me)).toBe(true);
    expect(isWhatsAppBotAddress("236283431522503@lid", me)).toBe(true);
    expect(isWhatsAppBotAddress("9999999999@s.whatsapp.net", me)).toBe(false);
  });

  test("handles a mention or a reply to the bot", () => {
    expect(
      explainGroupMessageHandling({
        me,
        mentionedJids: ["628100000000@s.whatsapp.net"],
        quotedParticipant: null,
        text: "@Muse hello",
      }).shouldHandle
    ).toBe(true);

    expect(
      explainGroupMessageHandling({
        me,
        mentionedJids: [],
        quotedParticipant: me.lid ?? null,
        text: "follow up",
      }).shouldHandle
    ).toBe(true);
  });

  test("ignores a plain group message when mention is required", () => {
    expect(
      explainGroupMessageHandling({
        me,
        mentionedJids: [],
        quotedParticipant: null,
        text: "hello",
      }).shouldHandle
    ).toBe(false);
  });

  test("accepts plain text when mention is not required", () => {
    expect(
      explainGroupMessageHandling({
        mentionedJids: [],
        quotedParticipant: null,
        requireMention: false,
        text: "hello",
      })
    ).toEqual({ reason: "open-listen", shouldHandle: true });
  });

  test("ignores a message when bot identity is missing", () => {
    expect(
      explainGroupMessageHandling({
        mentionedJids: ["628100000000@s.whatsapp.net"],
        quotedParticipant: null,
        text: "hello",
      })
    ).toEqual({ reason: "missing-bot-info", shouldHandle: false });
  });

  test("strips mention tokens", () => {
    expect(stripWhatsAppBotMention("hi @Muse there")).toBe("hi there");
    expect(stripWhatsAppBotMention("@Muse")).toBe("");
  });
});
```

- [ ] **Step 5: Run the test and verify it fails**

Run: `bun test src/whatsapp/group-message.test.ts`

Expected: FAIL because `./group-message` does not exist.

- [ ] **Step 6: Write `src/whatsapp/group-message.ts`**

```ts
// Adapted from Nakama (MIT). See LICENSE.nakama.
import { areJidsSameUser, isJidGroup } from "@whiskeysockets/baileys";

export interface WhatsAppAccount {
  id: string;
  lid?: string | null;
}

export interface GroupMessageHandlingDecision {
  reason:
    | "missing-bot-info"
    | "reply-to-bot"
    | "bot-mention"
    | "open-listen"
    | "no-text"
    | "no-trigger";
  shouldHandle: boolean;
}

export function isWhatsAppGroupChat(jid: string): boolean {
  return Boolean(isJidGroup(jid));
}

export function isWhatsAppBotAddress(
  jid: string | null | undefined,
  me: WhatsAppAccount | undefined
): boolean {
  if (!(jid && me)) {
    return false;
  }

  if (areJidsSameUser(jid, me.id)) {
    return true;
  }

  return Boolean(me.lid && areJidsSameUser(jid, me.lid));
}

export function explainGroupMessageHandling(input: {
  mentionedJids: string[];
  quotedParticipant: string | null;
  text: string;
  me?: WhatsAppAccount | undefined;
  requireMention?: boolean;
}): GroupMessageHandlingDecision {
  const text = input.text.trim();

  if (input.requireMention === false) {
    return {
      reason: text ? "open-listen" : "no-text",
      shouldHandle: Boolean(text),
    };
  }

  if (!input.me) {
    return { reason: "missing-bot-info", shouldHandle: false };
  }

  if (isWhatsAppBotAddress(input.quotedParticipant, input.me)) {
    return { reason: "reply-to-bot", shouldHandle: true };
  }

  if (input.mentionedJids.some((jid) => isWhatsAppBotAddress(jid, input.me))) {
    return { reason: "bot-mention", shouldHandle: true };
  }

  return {
    reason: text ? "no-trigger" : "no-text",
    shouldHandle: false,
  };
}

export function stripWhatsAppBotMention(text: string): string {
  return text.replace(/@\S+/g, "").replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 7: Run both tests**

Run:

```bash
bun test src/whatsapp/format.test.ts src/whatsapp/group-message.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 9: Commit (only if the user asked for commits)**

```bash
git add src/whatsapp/format.ts src/whatsapp/format.test.ts src/whatsapp/group-message.ts src/whatsapp/group-message.test.ts
git commit -m "feat: add WhatsApp formatting and group helpers"
```

---

### Task 7: Copy the low-level Baileys modules

**Files:**
- Create: `src/whatsapp/auth-state.ts`
- Create: `src/whatsapp/auth-state.test.ts`
- Create: `src/whatsapp/baileys-logger.ts`
- Create: `src/whatsapp/baileys-logger.test.ts`
- Create: `src/whatsapp/inbound-message.ts`
- Create: `src/whatsapp/inbound-message.test.ts`
- Create: `src/whatsapp/log-metadata.ts`
- Create: `src/whatsapp/log-metadata.test.ts`
- Create: `src/whatsapp/process-lifecycle.ts`

**Interfaces:**
- Produces: `usePrivateMultiFileAuthState(directory: string)`
- Produces: `createBaileysLogger(writeError?)`, `installBaileysConsoleRedaction(target?)`
- Produces: `WhatsAppInboundChat`, `parseInboundWhatsAppMessage`, `extractInboundText`, `isWhatsAppOutboundEcho`, `rememberWhatsAppOutbound`, `isPrivateWhatsAppChat`, `isSelfWhatsAppChat`, `shouldHandleInboundMessage`, `resetWhatsAppOutboundForTests`.
- Produces: `maskWhatsAppJid(jid)`.
- Produces: `registerProcessLifecycleHandlers(cleanup)`.

- [ ] **Step 1: Copy the files**

Run:

```bash
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/auth-state.ts src/whatsapp/auth-state.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/baileys-logger.ts src/whatsapp/baileys-logger.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/inbound-message.ts src/whatsapp/inbound-message.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/log-metadata.ts src/whatsapp/log-metadata.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/process-lifecycle.ts src/whatsapp/process-lifecycle.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/auth-state.test.ts src/whatsapp/auth-state.test.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/baileys-logger.test.ts src/whatsapp/baileys-logger.test.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/inbound-message.test.ts src/whatsapp/inbound-message.test.ts
cp /home/arkan/projects/nakama/apps/platform/whatsapp/src/log-metadata.test.ts src/whatsapp/log-metadata.test.ts
```

- [ ] **Step 2: Patch `auth-state.ts`**

Replace this import:

```ts
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "@nakama/core/fs";
```

with:

```ts
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
```

- [ ] **Step 3: Add the license header to every copied source file**

Add this line as the first line of `auth-state.ts`, `baileys-logger.ts`, `inbound-message.ts`, `log-metadata.ts`, and `process-lifecycle.ts`:

```ts
// Adapted from Nakama (MIT). See LICENSE.nakama.
```

- [ ] **Step 4: Run the copied tests**

Run:

```bash
bun test src/whatsapp/auth-state.test.ts src/whatsapp/baileys-logger.test.ts src/whatsapp/inbound-message.test.ts src/whatsapp/log-metadata.test.ts
```

Expected: PASS. If a test imports a removed Nakama helper, delete only that test case and keep the rest.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/whatsapp/auth-state.ts src/whatsapp/auth-state.test.ts src/whatsapp/baileys-logger.ts src/whatsapp/baileys-logger.test.ts src/whatsapp/inbound-message.ts src/whatsapp/inbound-message.test.ts src/whatsapp/log-metadata.ts src/whatsapp/log-metadata.test.ts src/whatsapp/process-lifecycle.ts
git commit -m "feat: port Baileys transport helpers from Nakama"
```

---

### Task 8: Baileys socket with reconnect

**Files:**
- Create: `src/whatsapp/socket.ts`
- Create: `src/whatsapp/socket.test.ts`

**Interfaces:**
- Consumes: `usePrivateMultiFileAuthState`, `createBaileysLogger`, `parseInboundWhatsAppMessage`, `isWhatsAppOutboundEcho`, `rememberWhatsAppOutbound`, `maskWhatsAppJid`.
- Produces: `createWhatsAppSocket(deps: WhatsAppSocketDeps): Promise<WhatsAppSocketHandle>`
- Produces: `WhatsAppSocketDeps` with `authDir`, `onConnected?`, `onDisconnected?`, `onMessage`, `onQr?`.
- Produces: `WhatsAppSocketHandle` with `socket`, `start()`, `stop()`.

- [ ] **Step 1: Write the failing test**

Write `src/whatsapp/socket.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { isChannelDebugEnabled } from "./socket";

describe("isChannelDebugEnabled", () => {
  const previous = process.env.MUSE_CH_DEBUG;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.MUSE_CH_DEBUG;
    } else {
      process.env.MUSE_CH_DEBUG = previous;
    }
  });

  test("is off by default", () => {
    delete process.env.MUSE_CH_DEBUG;
    expect(isChannelDebugEnabled()).toBe(false);
  });

  test("is on when MUSE_CH_DEBUG=1", () => {
    process.env.MUSE_CH_DEBUG = "1";
    expect(isChannelDebugEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/whatsapp/socket.test.ts`

Expected: FAIL because `./socket` does not exist.

- [ ] **Step 3: Write `src/whatsapp/socket.ts`**

```ts
// Adapted from Nakama (MIT). See LICENSE.nakama.
import {
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  jidDecode,
  jidEncode,
  makeWASocket,
  type WASocket,
} from "@whiskeysockets/baileys";
import { usePrivateMultiFileAuthState } from "./auth-state";
import { createBaileysLogger } from "./baileys-logger";
import {
  extractInboundText,
  isWhatsAppOutboundEcho,
  parseInboundWhatsAppMessage,
  rememberWhatsAppOutbound,
  type WhatsAppInboundChat,
} from "./inbound-message";
import { maskWhatsAppJid } from "./log-metadata";

export function isChannelDebugEnabled(): boolean {
  return process.env.MUSE_CH_DEBUG === "1";
}

export interface WhatsAppSocketDeps {
  authDir: string;
  onConnected?: (me: { id: string; lid?: string | null }) => void;
  onDisconnected?: () => void;
  onLoggedOut?: () => void;
  onMessage: (data: WhatsAppInboundChat) => Promise<void>;
  onQr?: (qr: string) => void;
}

export interface WhatsAppSocketHandle {
  socket: WASocket | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface DisconnectDiagnostic {
  code?: string;
  message?: string;
}

type DisconnectDiagnosticValue = DisconnectDiagnostic | string;

export async function createWhatsAppSocket(
  deps: WhatsAppSocketDeps
): Promise<WhatsAppSocketHandle> {
  const { state, saveCreds } = await usePrivateMultiFileAuthState(deps.authDir);
  let socket: WASocket | null = null;
  let stopped = false;
  let generation = 0;
  let reconnectAttempt = 0;
  const baileysLogger = createBaileysLogger();

  const handle: WhatsAppSocketHandle = {
    get socket() {
      return socket;
    },
    async start() {
      if (stopped) {
        return;
      }

      const myGen = ++generation;
      const previous = socket;
      socket = null;
      void retireSocket(previous);

      const next = makeWASocket({
        auth: state,
        browser: ["Muse WhatsApp Bridge", "Chrome", "1.0.0"],
        connectTimeoutMs: 30_000,
        logger: baileysLogger,
        makeSignalRepository(auth, logger, pnToLIDFunc) {
          const repository = DEFAULT_CONNECTION_CONFIG.makeSignalRepository(
            auth,
            logger,
            pnToLIDFunc
          );
          const decrypt = repository.decryptMessage.bind(repository);
          const recovered = new Map<string, string>();

          repository.decryptMessage = async (message) => {
            const sender = jidDecode(message.jid);
            const pn = jidDecode(state.creds.me?.id);
            const lid = jidDecode(state.creds.me?.lid);
            const alternate =
              sender?.server === "lid" && sender.user === lid?.user
                ? pn
                : sender?.server === "s.whatsapp.net" &&
                    sender.user === pn?.user
                  ? lid
                  : undefined;

            if (!(sender && alternate)) {
              return decrypt(message);
            }

            const alternateJid = jidEncode(
              alternate.user,
              alternate.server,
              sender.device
            );
            const primary = recovered.get(message.jid) ?? message.jid;

            try {
              return await decrypt({ ...message, jid: primary });
            } catch (error) {
              if (
                !(error instanceof Error) ||
                (error.name !== "SessionError" && error.message !== "Bad MAC")
              ) {
                throw error;
              }

              const fallback =
                primary === message.jid ? alternateJid : message.jid;

              try {
                const plaintext = await decrypt({ ...message, jid: fallback });
                recovered.set(message.jid, fallback);
                return plaintext;
              } catch {
                throw error;
              }
            }
          };

          return repository;
        },
        markOnlineOnConnect: false,
        printQRInTerminal: false,
        retryRequestDelayMs: 2000,
        syncFullHistory: false,
      });

      if (myGen !== generation || stopped) {
        void retireSocket(next);
        return;
      }

      socket = next;
      wrapSocketSendMessage(next);

      next.ev.on("connection.update", async (update) => {
        if (myGen !== generation) {
          return;
        }

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          deps.onQr?.(qr);
        }

        if (connection === "open") {
          reconnectAttempt = 0;
          const me = state.creds.me;

          if (me?.id) {
            deps.onConnected?.({ id: me.id, lid: me.lid ?? null });
          }
        }

        if (connection === "close") {
          generation += 1;
          next.ev.destroy();
          deps.onDisconnected?.();

          const error = lastDisconnect?.error as
            | {
                output?: { statusCode?: number };
                cause?: DisconnectDiagnosticValue;
                data?: DisconnectDiagnosticValue;
              }
            | undefined;
          const statusCode = error?.output?.statusCode;
          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut && !stopped;

          console.log(
            `WhatsApp disconnected ${JSON.stringify({
              cause: safeDisconnectReason(error?.cause ?? error?.data),
              code: statusCode ?? null,
              message: safeDisconnectReason(error),
              reconnect: shouldReconnect,
              timestamp: new Date().toISOString(),
            })}`
          );

          if (!shouldReconnect) {
            if (statusCode === DisconnectReason.loggedOut) {
              deps.onLoggedOut?.();
            }

            return;
          }

          const waitMs =
            Math.min(60_000, 1000 * 2 ** Math.min(reconnectAttempt, 6)) +
            Math.floor(Math.random() * 500);
          reconnectAttempt += 1;

          await new Promise<void>((resolve) => {
            setTimeout(resolve, waitMs);
          });

          if (stopped) {
            return;
          }

          await handle.start();
        }
      });

      next.ev.on("creds.update", saveCreds);

      next.ev.on("messages.upsert", async (event) => {
        if (myGen !== generation || stopped) {
          return;
        }

        if (event.type !== "notify" && event.type !== "append") {
          return;
        }

        const me = state.creds.me;

        for (const message of event.messages) {
          const remoteJid = message.key.remoteJid ?? null;
          const text = extractInboundText(message.message);
          const inbound = parseInboundWhatsAppMessage(message, me, {
            requireGroupMention: false,
          });

          if (remoteJid && isChannelDebugEnabled()) {
            console.log(
              `WhatsApp upsert item id=${message.key.id ?? "-"} jid=${maskWhatsAppJid(remoteJid)} fromMe=${message.key.fromMe ? "yes" : "no"} textBytes=${Buffer.byteLength(text, "utf8")} handle=${inbound ? "yes" : "no"}`
            );
          }

          if (
            !inbound ||
            isWhatsAppOutboundEcho({
              fromMe: inbound.fromMe,
              id: inbound.messageId,
              jid: inbound.jid,
              text: inbound.text,
            })
          ) {
            continue;
          }

          if (myGen !== generation || stopped) {
            return;
          }

          try {
            await deps.onMessage(inbound);
          } catch (error) {
            console.error("WhatsApp inbound message handling failed.", {
              error: error instanceof Error ? error.message : String(error),
              jid: maskWhatsAppJid(inbound.jid),
              messageId: message.key.id ?? null,
            });
          }
        }
      });
    },
    async stop() {
      stopped = true;
      generation += 1;
      const current = socket;
      socket = null;
      await retireSocket(current);
    },
  };

  return handle;
}

function safeDisconnectReason(
  error: DisconnectDiagnosticValue | null | undefined
): string | null {
  if (error == null) {
    return null;
  }

  const diagnostic: DisconnectDiagnostic =
    error instanceof Object ? error : { message: error };
  const message = String(diagnostic.message ?? "");
  const code = String(diagnostic.code ?? "");

  if (
    /^(QR refs attempts ended|Timed Out|Connection was lost|Connection Closed|Connection Terminated|Connection Terminated by Server|Connection Failure|Logged Out|Intentional Logout|Restart Required|Pre-key upload timeout|Multi-device beta not joined|Stream Errored \((conflict|restart required|connection failure)\))$/.test(
      message
    )
  ) {
    return message;
  }

  if (
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH)$/.test(
      code
    )
  ) {
    return code;
  }

  return "[redacted]";
}

function wrapSocketSendMessage(target: WASocket): void {
  if (!target.sendMessage) {
    return;
  }

  const sendMessage = target.sendMessage.bind(target);
  target.sendMessage = ((jid, content, options) => {
    const text = outboundTextFromContent(content);

    if (text) {
      rememberWhatsAppOutbound({ jid, text });
    }

    return Promise.resolve(sendMessage(jid, content, options)).then(
      (result) => {
        rememberWhatsAppOutbound({
          id: result?.key?.id ?? null,
          jid,
          text,
        });
        return result;
      }
    );
  }) as WASocket["sendMessage"];
}

function outboundTextFromContent(
  content: Parameters<WASocket["sendMessage"]>[1]
): string {
  if ("text" in content && content.text?.trim()) {
    return content.text;
  }

  if ("caption" in content && content.caption) {
    return content.caption;
  }

  return "";
}

function retireSocket(target: WASocket | null | undefined): Promise<void> {
  if (!target) {
    return Promise.resolve();
  }

  target.ev.destroy();

  return Promise.resolve(target.end(undefined));
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/whatsapp/socket.test.ts`

Expected: PASS.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass. Fix type errors from Baileys option types before moving on.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/whatsapp/socket.ts src/whatsapp/socket.test.ts
git commit -m "feat: add Baileys socket with reconnect"
```

---

### Task 9: Message handler

**Files:**
- Create: `src/bridge/handler.ts`
- Create: `src/bridge/handler.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig`, `ChatClient`, `MuseMessage`, `HistoryStore`, `AllowlistFile`, `AllowlistStore`, `MessageDeduper`, `RateLimiter`, `WhatsAppInboundChat`, `explainGroupMessageHandling`, `stripWhatsAppBotMention`, `prepareWhatsAppReply`, `splitWhatsAppMessage`.
- Produces: `HandlerDeps` with `config`, `muse`, `history`, `getAllowlist`, `refreshAllowlist`, `sendText`, `sendTyping`, optional `deduper`, optional `rateLimiter`, optional `concurrency`, optional `logger`.
- Produces: `createHandler(deps): (inbound: WhatsAppInboundChat) => Promise<void>`.

- [ ] **Step 1: Write the failing test**

Write `src/bridge/handler.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { AllowlistFile } from "../access/allowlist";
import type { BridgeConfig } from "../config";
import type { ChatMessage } from "../muse/history";
import type { MuseMessage } from "../muse/client";
import type { WhatsAppInboundChat } from "../whatsapp/inbound-message";
import { createHandler } from "./handler";
import {
  ConcurrencyLimiter,
  MessageDeduper,
  RateLimiter,
} from "./guards";

const config: BridgeConfig = {
  museBaseUrl: "http://muse.local/v1",
  museModel: "muse-1",
  stateDir: "/tmp/muse",
  groupRequireMention: true,
  historyMaxTurns: 20,
  requestTimeoutMs: 1000,
};

const dmAllowlist: AllowlistFile = {
  dm: [
    "6281234567890@s.whatsapp.net",
    "6281234567891@s.whatsapp.net",
  ],
  groups: {
    "120363000000000000@g.us": {
      allowAll: false,
      members: ["6281234567890@s.whatsapp.net"],
    },
  },
};

function inbound(
  overrides: Partial<WhatsAppInboundChat> = {}
): WhatsAppInboundChat {
  return {
    fromMe: false,
    isGroup: false,
    jid: "6281234567890@s.whatsapp.net",
    me: { id: "6289999999999@s.whatsapp.net", lid: "999@lid" },
    mentionedJids: [],
    messageId: "m1",
    quotedParticipant: null,
    quotedText: null,
    senderJid: "6281234567890@s.whatsapp.net",
    senderJids: ["6281234567890@s.whatsapp.net"],
    text: "hello",
    ...overrides,
  };
}

function createDeps(reply = " hi ") {
  const messages: MuseMessage[][] = [];
  const sent: Array<{ jid: string; text: string }> = [];
  const typing: Array<{ jid: string; state: string }> = [];
  const historyByKey = new Map<string, ChatMessage[]>();

  return {
    messages,
    sent,
    typing,
    deps: {
      config,
      muse: {
        chat: async (input: MuseMessage[]) => {
          messages.push(input);
          return reply;
        },
      },
      history: {
        get: (key: string) => historyByKey.get(key) ?? [],
        append: async (key: string, message: ChatMessage) => {
          historyByKey.set(key, [...(historyByKey.get(key) ?? []), message]);
        },
      },
      getAllowlist: () => dmAllowlist,
      refreshAllowlist: async () => dmAllowlist,
      sendText: async (jid: string, text: string) => {
        sent.push({ jid, text });
      },
      sendTyping: async (jid: string, state: string) => {
        typing.push({ jid, state });
      },
      deduper: new MessageDeduper(),
      rateLimiter: new RateLimiter(),
      logger: { info: () => {}, error: () => {} },
    },
  };
}

describe("createHandler", () => {
  test("answers an allowed DM and sends the split reply", async () => {
    const { deps, messages, sent, typing } = createDeps("hello");
    const handler = createHandler(deps);

    await handler(inbound());

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual([{ role: "user", content: "hello" }]);
    expect(sent).toEqual([
      { jid: "6281234567890@s.whatsapp.net", text: "hello" },
    ]);
    expect(typing).toEqual([
      { jid: "6281234567890@s.whatsapp.net", state: "composing" },
      { jid: "6281234567890@s.whatsapp.net", state: "paused" },
    ]);
  });

  test("does not answer an unknown DM", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(
      inbound({
        jid: "999@s.whatsapp.net",
        senderJid: "999@s.whatsapp.net",
        senderJids: ["999@s.whatsapp.net"],
      })
    );

    expect(messages).toHaveLength(0);
  });

  test("answers an allowed group mention with a sender prefix", async () => {
    const { deps, messages } = createDeps("ok");
    const handler = createHandler(deps);

    await handler(
      inbound({
        isGroup: true,
        jid: "120363000000000000@g.us",
        mentionedJids: ["6289999999999@s.whatsapp.net"],
        text: "@Muse hello",
      })
    );

    expect(messages[0]).toEqual([
      {
        role: "user",
        content: "[sender: +6281234567890] hello",
      },
    ]);
  });

  test("ignores a group message without a mention", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(
      inbound({
        isGroup: true,
        jid: "120363000000000000@g.us",
        text: "hello",
      })
    );

    expect(messages).toHaveLength(0);
  });

  test("ignores a group message from a non-member", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(
      inbound({
        isGroup: true,
        jid: "120363000000000000@g.us",
        mentionedJids: ["6289999999999@s.whatsapp.net"],
        senderJid: "999@s.whatsapp.net",
        senderJids: ["999@s.whatsapp.net"],
      })
    );

    expect(messages).toHaveLength(0);
  });

  test("sends one error reply when Muse fails", async () => {
    const { deps, sent } = createDeps();
    deps.muse.chat = async () => {
      throw new Error("down");
    };
    const handler = createHandler(deps);

    await handler(inbound());

    expect(sent).toEqual([
      {
        jid: "6281234567890@s.whatsapp.net",
        text: "Muse is not available right now. Please try again.",
      },
    ]);
  });

  test("ignores own messages and empty text", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(inbound({ fromMe: true }));
    await handler(inbound({ text: "   " }));

    expect(messages).toHaveLength(0);
  });

  test("deduplicates a repeated message id", async () => {
    const { deps, messages } = createDeps();
    const handler = createHandler(deps);

    await handler(inbound());
    await handler(inbound());

    expect(messages).toHaveLength(1);
  });

  test("applies the rate limit", async () => {
    const { deps, messages } = createDeps();
    deps.rateLimiter = new RateLimiter(1, 60_000);
    const handler = createHandler(deps);

    await handler(inbound({ messageId: "m1" }));
    await handler(inbound({ messageId: "m2" }));

    expect(messages).toHaveLength(1);
  });

  test("caps concurrent Muse calls across conversations", async () => {
    const { deps } = createDeps();
    deps.concurrency = new ConcurrencyLimiter(1);
    let active = 0;
    let maxActive = 0;
    deps.muse.chat = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "ok";
    };
    const handler = createHandler(deps);

    await Promise.all([
      handler(
        inbound({
          jid: "6281234567890@s.whatsapp.net",
          messageId: "m1",
        })
      ),
      handler(
        inbound({
          jid: "6281234567891@s.whatsapp.net",
          senderJid: "6281234567891@s.whatsapp.net",
          senderJids: ["6281234567891@s.whatsapp.net"],
          messageId: "m2",
        })
      ),
    ]);

    expect(maxActive).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/bridge/handler.test.ts`

Expected: FAIL because `./handler` does not exist.

- [ ] **Step 3: Write `src/bridge/handler.ts`**

```ts
import {
  type AllowlistFile,
  isDmAllowed,
  isGroupConfigured,
  isGroupSenderAllowed,
} from "../access/allowlist";
import type { BridgeConfig } from "../config";
import type { ChatClient, MuseMessage } from "../muse/client";
import type { ChatMessage } from "../muse/history";
import { prepareWhatsAppReply, splitWhatsAppMessage } from "../whatsapp/format";
import {
  explainGroupMessageHandling,
  stripWhatsAppBotMention,
} from "../whatsapp/group-message";
import type { WhatsAppInboundChat } from "../whatsapp/inbound-message";
import {
  ConcurrencyLimiter,
  MessageDeduper,
  RateLimiter,
} from "./guards";

const MAX_INPUT_BYTES = 16 * 1024;
const ERROR_REPLY = "Muse is not available right now. Please try again.";

interface Logger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface HistoryWriter {
  get: (key: string) => ChatMessage[];
  append: (key: string, message: ChatMessage) => Promise<void>;
}

export interface HandlerDeps {
  config: BridgeConfig;
  muse: ChatClient;
  history: HistoryWriter;
  getAllowlist: () => AllowlistFile;
  refreshAllowlist: () => Promise<AllowlistFile>;
  sendText: (jid: string, text: string) => Promise<void>;
  sendTyping: (jid: string, state: "composing" | "paused") => Promise<void>;
  deduper?: MessageDeduper;
  rateLimiter?: RateLimiter;
  concurrency?: ConcurrencyLimiter;
  logger?: Logger;
}

export function createHandler(deps: HandlerDeps) {
  const deduper = deps.deduper ?? new MessageDeduper();
  const rateLimiter = deps.rateLimiter ?? new RateLimiter();
  const concurrency = deps.concurrency ?? new ConcurrencyLimiter(4);
  const locks = new Set<string>();
  const logger = deps.logger ?? console;

  return async function handleMessage(
    inbound: WhatsAppInboundChat
  ): Promise<void> {
    const text = inbound.text.trim();

    if (!text || inbound.fromMe) {
      return;
    }

    if (deduper.has(inbound.messageId)) {
      return;
    }

    deduper.remember(inbound.messageId);

    const allowlist = await deps.refreshAllowlist();
    const senderKey = inbound.senderJid || inbound.jid;

    if (!rateLimiter.allow(senderKey)) {
      return;
    }

    if (inbound.isGroup) {
      const decision = explainGroupMessageHandling({
        me: inbound.me,
        mentionedJids: inbound.mentionedJids,
        quotedParticipant: inbound.quotedParticipant,
        requireMention: deps.config.groupRequireMention,
        text,
      });

      if (!decision.shouldHandle) {
        return;
      }

      if (!isGroupConfigured(allowlist, inbound.jid)) {
        return;
      }

      if (!isGroupSenderAllowed(allowlist, inbound.jid, inbound.senderJids)) {
        return;
      }
    } else if (!isDmAllowed(allowlist, inbound.senderJids)) {
      return;
    }

    const conversationKey = inbound.jid;

    if (locks.has(conversationKey)) {
      return;
    }

    locks.add(conversationKey);

    try {
      try {
        await deps.sendTyping(inbound.jid, "composing");
      } catch {
        // Typing is best effort. Never block the reply.
      }

      const content = inbound.isGroup
        ? `[sender: ${senderLabel(inbound.senderJid)}] ${stripWhatsAppBotMention(text)}`
        : text;
      const userContent = truncateUtf8(content, MAX_INPUT_BYTES);

      await deps.history.append(conversationKey, {
        role: "user",
        content: userContent,
      });

      const messages: MuseMessage[] = [
        ...(deps.config.museSystemPrompt
          ? [
              {
                role: "system" as const,
                content: deps.config.museSystemPrompt,
              },
            ]
          : []),
        ...deps.history.get(conversationKey),
      ];

      const reply = await concurrency.run(() => deps.muse.chat(messages));

      await deps.history.append(conversationKey, {
        role: "assistant",
        content: reply,
      });

      for (const part of splitWhatsAppMessage(prepareWhatsAppReply(reply))) {
        await deps.sendText(inbound.jid, part);
      }
    } catch (error) {
      logger.error("Muse reply failed.", {
        error: error instanceof Error ? error.message : String(error),
        jid: inbound.jid,
      });

      try {
        await deps.sendText(inbound.jid, ERROR_REPLY);
      } catch {
        // The WhatsApp connection is down. The reconnect loop will recover.
      }
    } finally {
      try {
        await deps.sendTyping(inbound.jid, "paused");
      } catch {
        // Typing is best effort.
      }

      locks.delete(conversationKey);
    }
  };
}

function senderLabel(jid: string): string {
  const [user = "", server = ""] = jid.split("@");
  const digits = user.split(":")[0] ?? user;

  return server === "s.whatsapp.net" ? `+${digits}` : jid;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  let result = text;

  while (Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, -1);
  }

  return result;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/bridge/handler.test.ts`

Expected: PASS.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/bridge/handler.ts src/bridge/handler.test.ts
git commit -m "feat: add message handler with policy gate"
```

---

### Task 10: Application wiring

**Files:**
- Create: `src/app.ts`
- Create: `src/app.test.ts`
- Create: `src/index.ts`

**Interfaces:**
- Consumes: all earlier modules.
- Produces: `AppOptions` with optional `muse` and optional `socketFactory`.
- Produces: `startApp(config: BridgeConfig, options?: AppOptions): Promise<{ stop: () => Promise<void> }>`.

- [ ] **Step 1: Write the failing test**

Write `src/app.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./config";
import { startApp } from "./app";
import type { WhatsAppInboundChat } from "./whatsapp/inbound-message";
import type { WhatsAppSocketDeps, WhatsAppSocketHandle } from "./whatsapp/socket";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-app-"));
  directories.push(directory);
  return directory;
}

function inbound(): WhatsAppInboundChat {
  return {
    fromMe: false,
    isGroup: false,
    jid: "6281234567890@s.whatsapp.net",
    me: { id: "6289999999999@s.whatsapp.net" },
    mentionedJids: [],
    messageId: "m1",
    quotedParticipant: null,
    quotedText: null,
    senderJid: "6281234567890@s.whatsapp.net",
    senderJids: ["6281234567890@s.whatsapp.net"],
    text: "hello",
  };
}

describe("startApp", () => {
  test("wires the socket handler to Muse and sends the reply", async () => {
    const stateDir = await tempDirectory();
    const config: BridgeConfig = {
      museBaseUrl: "http://muse.local/v1",
      museModel: "muse-1",
      stateDir,
      groupRequireMention: true,
      historyMaxTurns: 20,
      requestTimeoutMs: 1000,
    };
    await writeFile(
      join(stateDir, "allowlist.json"),
      JSON.stringify({
        dm: ["6281234567890@s.whatsapp.net"],
        groups: {},
      })
    );

    let captured: WhatsAppSocketDeps | null = null;
    const sent: string[] = [];
    const socketFactory = async (
      deps: WhatsAppSocketDeps
    ): Promise<WhatsAppSocketHandle> => {
      captured = deps;
      return {
        socket: {
          sendMessage: async (_jid: string, content: { text: string }) => {
            sent.push(content.text);
            return { key: { id: "out-1" } };
          },
          sendPresenceUpdate: async () => {},
        } as never,
        start: async () => {},
        stop: async () => {},
      };
    };
    const muse = { chat: async () => "hello back" };

    const app = await startApp(config, { muse, socketFactory });

    expect(captured).not.toBeNull();
    await captured?.onMessage(inbound());

    expect(sent).toEqual(["hello back"]);
    await app.stop();
  });

  test("calls a real OpenAI-compatible server through MuseClient", async () => {
    const stateDir = await tempDirectory();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          choices: [{ message: { content: "from the server" } }],
        }),
    });
    const config: BridgeConfig = {
      museBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      museModel: "muse-1",
      stateDir,
      groupRequireMention: true,
      historyMaxTurns: 20,
      requestTimeoutMs: 1000,
    };
    await writeFile(
      join(stateDir, "allowlist.json"),
      JSON.stringify({
        dm: ["6281234567890@s.whatsapp.net"],
        groups: {},
      })
    );

    let captured: WhatsAppSocketDeps | null = null;
    const sent: string[] = [];
    const socketFactory = async (
      deps: WhatsAppSocketDeps
    ): Promise<WhatsAppSocketHandle> => {
      captured = deps;
      return {
        socket: {
          sendMessage: async (_jid: string, content: { text: string }) => {
            sent.push(content.text);
            return { key: { id: "out-1" } };
          },
          sendPresenceUpdate: async () => {},
        } as never,
        start: async () => {},
        stop: async () => {},
      };
    };

    try {
      const app = await startApp(config, { socketFactory });

      await captured?.onMessage(inbound());

      expect(sent).toEqual(["from the server"]);
      await app.stop();
    } finally {
      server.stop(true);
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/app.test.ts`

Expected: FAIL because `./app` does not exist.

- [ ] **Step 3: Write `src/app.ts`**

```ts
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AllowlistStore } from "./access/allowlist";
import { createHandler } from "./bridge/handler";
import type { BridgeConfig } from "./config";
import { MuseClient, type ChatClient } from "./muse/client";
import { HistoryStore } from "./muse/history";
import {
  createWhatsAppSocket,
  type WhatsAppSocketDeps,
  type WhatsAppSocketHandle,
} from "./whatsapp/socket";

export interface AppOptions {
  muse?: Pick<ChatClient, "chat">;
  socketFactory?: (
    deps: WhatsAppSocketDeps
  ) => Promise<WhatsAppSocketHandle>;
  onLoggedOut?: () => void;
}

export async function startApp(
  config: BridgeConfig,
  options: AppOptions = {}
): Promise<{ stop: () => Promise<void> }> {
  await mkdir(config.stateDir, { mode: 0o700, recursive: true });
  await chmod(config.stateDir, 0o700);

  const allowlist = new AllowlistStore(
    join(config.stateDir, "allowlist.json")
  );
  await allowlist.load();

  const history = new HistoryStore(
    join(config.stateDir, "history.json"),
    config.historyMaxTurns
  );
  await history.load();

  const muse: Pick<ChatClient, "chat"> =
    options.muse ??
    new MuseClient({
      baseUrl: config.museBaseUrl,
      apiKey: config.museApiKey,
      model: config.museModel,
      timeoutMs: config.requestTimeoutMs,
    });

  let socketHandle: WhatsAppSocketHandle | null = null;

  const handler = createHandler({
    config,
    muse,
    history,
    getAllowlist: () => allowlist.get(),
    refreshAllowlist: () => allowlist.refresh(),
    sendText: async (jid, text) => {
      const socket = socketHandle?.socket;

      if (!socket) {
        throw new Error("WhatsApp socket is not connected");
      }

      await socket.sendMessage(jid, { text });
    },
    sendTyping: async (jid, state) => {
      await socketHandle?.socket?.sendPresenceUpdate(state, jid);
    },
  });

  const socket = await (options.socketFactory ?? createWhatsAppSocket)({
    authDir: join(config.stateDir, "auth"),
    onLoggedOut: options.onLoggedOut,
    onMessage: handler,
    onQr: () => {
      console.error(
        "WhatsApp requested a new link. Stop the service and run the pairing command."
      );
    },
  });

  socketHandle = socket;
  await socket.start();

  return {
    stop: () => socket.stop(),
  };
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
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
```

- [ ] **Step 5: Run the test**

Run: `bun test src/app.test.ts`

Expected: PASS.

- [ ] **Step 6: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 7: Commit (only if the user asked for commits)**

```bash
git add src/app.ts src/app.test.ts src/index.ts
git commit -m "feat: wire bridge application"
```

---

### Task 11: Pairing CLI

**Files:**
- Create: `src/cli/pair.ts`
- Create: `src/cli/pair.test.ts`

**Interfaces:**
- Produces: `parsePairArgs(argv: string[]): { phone?: string }`
- Produces: `normalizePairingPhone(value: string): string`
- Produces: `runPair(argv?: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Write `src/cli/pair.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizePairingPhone, parsePairArgs } from "./pair";

describe("pair CLI", () => {
  test("parses --phone", () => {
    expect(parsePairArgs(["--phone", "+62 812-3456-7890"])).toEqual({
      phone: "+62 812-3456-7890",
    });
  });

  test("parses --phone=value", () => {
    expect(parsePairArgs(["--phone=6281234567890"])).toEqual({
      phone: "6281234567890",
    });
  });

  test("returns an empty result without a phone", () => {
    expect(parsePairArgs([])).toEqual({});
  });

  test("normalizes a phone number to digits", () => {
    expect(normalizePairingPhone("+62 812-3456-7890")).toBe("6281234567890");
  });

  test("rejects a short phone number", () => {
    expect(() => normalizePairingPhone("123")).toThrow(
      "Phone number must have 6 to 15 digits"
    );
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/cli/pair.test.ts`

Expected: FAIL because `./pair` does not exist.

- [ ] **Step 3: Write `src/cli/pair.ts`**

```ts
import { join } from "node:path";
import { DisconnectReason, makeWASocket } from "@whiskeysockets/baileys";
import { loadStateConfig } from "../config";
import {
  createBaileysLogger,
  installBaileysConsoleRedaction,
} from "../whatsapp/baileys-logger";
import { usePrivateMultiFileAuthState } from "../whatsapp/auth-state";

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
    throw new Error(
      "Pass --phone +<number> or set WHATSAPP_PHONE_NUMBER."
    );
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

  const code = await socket.requestPairingCode(normalizedPhone);
  console.log(`Pairing code: ${code}`);
  console.log(
    "Open WhatsApp > Linked Devices > Link with phone number and enter the code."
  );

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
```

- [ ] **Step 4: Run the test**

Run: `bun test src/cli/pair.test.ts`

Expected: PASS.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/cli/pair.ts src/cli/pair.test.ts
git commit -m "feat: add headless pairing CLI"
```

---

### Task 12: Allowlist CLI

**Files:**
- Create: `src/cli/allow.ts`
- Create: `src/cli/allow.test.ts`

**Interfaces:**
- Produces: `applyAllowCommand(current: AllowlistFile, argv: string[]): AllowlistFile`
- Produces: `runAllow(argv?: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Write `src/cli/allow.test.ts`:

```ts
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

    expect(applyAllowCommand(current, ["dm", "remove", "+6281234567890"])).toEqual(
      { dm: [], groups: {} }
    );
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
    expect(() => applyAllowCommand(empty, ["nope"])).toThrow(
      "Usage: allow"
    );
  });

  test("rejects a group member command without a phone", () => {
    expect(() =>
      applyAllowCommand(empty, ["group", "member", "add", groupJid])
    ).toThrow("Usage: allow");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test src/cli/allow.test.ts`

Expected: FAIL because `./allow` does not exist.

- [ ] **Step 3: Write `src/cli/allow.ts`**

```ts
import { join } from "node:path";
import {
  addDm,
  addGroup,
  addGroupMember,
  allowlistSchema,
  type AllowlistFile,
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
  const current =
    (await readJsonFile(path, allowlistSchema)) ?? { dm: [], groups: {} };
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
```

- [ ] **Step 4: Run the test**

Run: `bun test src/cli/allow.test.ts`

Expected: PASS.

- [ ] **Step 5: Run checks**

Run:

```bash
bun x tsc --noEmit
bun x ultracite check
```

Expected: both pass. The import of `allowlistSchema` must come from `../access/allowlist`.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add src/cli/allow.ts src/cli/allow.test.ts
git commit -m "feat: add allowlist CLI"
```

---

### Task 13: Deployment files and README

**Files:**
- Create: `deploy/muse-whatsapp.service`
- Create: `README.md`

**Interfaces:**
- Produces: a systemd unit that runs `dist/index.js` as the `muse-whatsapp` user.
- Produces: operator instructions for build, install, pair, allowlist, run, and logs.

- [ ] **Step 1: Write `deploy/muse-whatsapp.service`**

```ini
[Unit]
Description=Muse WhatsApp Bridge
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=muse-whatsapp
Group=muse-whatsapp
WorkingDirectory=/opt/muse-whatsapp
EnvironmentFile=/etc/muse-whatsapp.env
StateDirectory=muse-whatsapp
StateDirectoryMode=0700
ExecStart=/usr/local/bin/bun /opt/muse-whatsapp/dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/muse-whatsapp

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write `README.md`**

```markdown
# Muse WhatsApp Bridge

A small standalone bridge that connects one WhatsApp number to an
OpenAI-compatible Muse agent. Text only. DMs need an allowlist entry. Groups
need a mention and an allowlisted member.

## Requirements

- Bun 1.4+
- A dedicated WhatsApp number on a spare phone
- A local OpenAI-compatible Muse API

## Build

```sh
bun install
bun run build
bun test
```

## Install on the VM

```sh
sudo useradd --system --home /var/lib/muse-whatsapp --shell /usr/sbin/nologin muse-whatsapp
sudo install -d -o muse-whatsapp -g muse-whatsapp -m 0700 /var/lib/muse-whatsapp
sudo install -d -o muse-whatsapp -g muse-whatsapp /opt/muse-whatsapp
sudo cp -r dist package.json node_modules /opt/muse-whatsapp/
sudo install -m 0600 /dev/null /etc/muse-whatsapp.env
sudo cp deploy/muse-whatsapp.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Fill `/etc/muse-whatsapp.env` from `.env.example`, then pair:

```sh
sudo systemctl stop muse-whatsapp
cd /opt/muse-whatsapp
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/pair.js --phone +62...
sudo systemctl enable --now muse-whatsapp
```

## Allowlist

```sh
cd /opt/muse-whatsapp
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js dm add +628123
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group add 120363...@g.us
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group member add 120363...@g.us +628123
```

The allowlist reloads on file change without a restart.

## Logs

```sh
journalctl -u muse-whatsapp -f
```

## Notes

- Baileys is unofficial. Keep message volume low and use a number you can lose.
- A `loggedOut` disconnect needs a new pairing.
- Group history is shared by all members.
```

- [ ] **Step 3: Build and verify the output**

Run:

```bash
bun run build
ls -la dist
```

Expected: `dist/index.js`, `dist/pair.js`, and `dist/allow.js` exist.

- [ ] **Step 4: Verify the systemd unit syntax**

Run:

```bash
systemd-analyze verify deploy/muse-whatsapp.service || true
```

Expected: no error about unit syntax. A missing executable path warning is fine
before install.

- [ ] **Step 5: Commit (only if the user asked for commits)**

```bash
git add deploy/muse-whatsapp.service README.md
git commit -m "chore: add systemd unit and operator README"
```

---

### Task 14: Full verification

**Files:**
- No new files.

- [ ] **Step 1: Run all tests**

Run: `bun test`

Expected: PASS with no failures.

- [ ] **Step 2: Type check**

Run: `bun x tsc --noEmit`

Expected: PASS with no errors.

- [ ] **Step 3: Lint**

Run: `bun x ultracite check`

Expected: PASS with no errors.

- [ ] **Step 4: Build**

Run: `bun run build`

Expected: PASS and `dist/index.js`, `dist/pair.js`, `dist/allow.js` exist.

- [ ] **Step 5: Manual smoke test on the VM**

1. Fill `/etc/muse-whatsapp.env`.
2. Pair the number with `dist/pair.js`.
3. Add your own number with `dist/allow.js dm add +<your number>`.
4. Start `muse-whatsapp` with systemd.
5. Send a DM from the allowed number. Expect a Muse reply.
6. Send a DM from a non-allowed number. Expect no reply.
7. Add a test group, mention the bot from an allowed member. Expect a reply.
8. Send a group message without a mention. Expect no reply.
9. Run `journalctl -u muse-whatsapp -f` and confirm no message text is logged.

- [ ] **Step 6: Commit (only if the user asked for commits)**

```bash
git add .
git commit -m "chore: verify Muse WhatsApp bridge"
```

---

## Self-Review Checklist

- [ ] Config covers all env values in the spec.
- [ ] Allowlist covers DM, group allowAll, group members, hot reload, CLI mutations, and an invalid initial file that denies all.
- [ ] History caps at `2 * HISTORY_MAX_TURNS`, prunes after 30 days, and serializes concurrent appends.
- [ ] Muse client handles success, non-2xx, empty content, invalid JSON, and timeout.
- [ ] Handler covers allowed DM, blocked DM, group mention, group no-mention, non-member, error, echo, dedup, rate limit, and global concurrency.
- [ ] Integration test uses a real `Bun.serve` OpenAI-compatible server through `MuseClient`.
- [ ] Socket implementation covers reconnect, `loggedOut`, echo suppression, and QR events.
- [ ] Pair CLI unit tests cover args and normalization; pairing success, already-paired, logout, and timeout are verified in the manual smoke test.
- [ ] Deployment covers systemd, env file, state directory, logs, and three flat build outputs.
- [ ] No task uses a placeholder such as TBD or TODO.
- [ ] Every type and function name used by a later task is defined in an earlier task.
