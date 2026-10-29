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
  const temporaryPath = join(directory, `.${process.pid}.${randomUUID()}.tmp`);

  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}
