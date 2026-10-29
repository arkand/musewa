import { readFile } from "node:fs/promises";
import { z } from "zod";

const urlSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      try {
        const parsedUrl = new URL(value);
        return Boolean(parsedUrl);
      } catch {
        return false;
      }
    },
    { message: "Must be a valid URL" }
  );

const baseSchema = z.object({
  GROUP_REQUIRE_MENTION: z.enum(["true", "false"]).default("true"),
  HISTORY_MAX_TURNS: z.coerce.number().int().positive().default(20),
  MUSE_API_KEY: z.string().trim().optional(),
  MUSE_BASE_URL: urlSchema,
  MUSE_MODEL: z.string().trim().min(1),
  MUSE_SYSTEM_PROMPT_FILE: z.string().trim().optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  STATE_DIR: z.string().trim().default("/var/lib/muse-whatsapp"),
  WHATSAPP_PHONE_NUMBER: z.string().trim().optional(),
});

const stateSchema = z.object({
  STATE_DIR: z.string().trim().default("/var/lib/muse-whatsapp"),
  WHATSAPP_PHONE_NUMBER: z.string().trim().optional(),
});

export interface BridgeConfig {
  groupRequireMention: boolean;
  historyMaxTurns: number;
  museApiKey?: string;
  museBaseUrl: string;
  museModel: string;
  museSystemPrompt?: string;
  requestTimeoutMs: number;
  stateDir: string;
  whatsappPhoneNumber?: string;
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
    groupRequireMention: value.GROUP_REQUIRE_MENTION === "true",
    historyMaxTurns: value.HISTORY_MAX_TURNS,
    museApiKey: value.MUSE_API_KEY || undefined,
    museBaseUrl: baseUrlWithoutTrailingSlash(value.MUSE_BASE_URL),
    museModel: value.MUSE_MODEL,
    museSystemPrompt,
    requestTimeoutMs: value.REQUEST_TIMEOUT_MS,
    stateDir: value.STATE_DIR,
    whatsappPhoneNumber: value.WHATSAPP_PHONE_NUMBER || undefined,
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
