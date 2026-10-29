import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../store/json-store";

const chatMessageSchema = z.object({
  content: z.string(),
  role: z.enum(["user", "assistant"]),
});

const conversationSchema = z.object({
  messages: z.array(chatMessageSchema),
  updatedAt: z.string(),
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
      messages: [],
      updatedAt: new Date(this.now()).toISOString(),
    };
    const messages = [...existing.messages, message].slice(-this.maxTurns * 2);

    this.data.conversations[key] = {
      messages,
      updatedAt: new Date(this.now()).toISOString(),
    };

    this.prune();

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await writeJsonFile(this.path, this.data);
      } catch (error) {
        console.error(
          "History write failed; keeping history in memory.",
          error
        );
      }
    });

    await this.writeQueue;
  }

  prune(): void {
    const cutoff = this.now() - MAX_AGE_MS;

    for (const [key, conversation] of Object.entries(this.data.conversations)) {
      if (Date.parse(conversation.updatedAt) < cutoff) {
        delete this.data.conversations[key];
      }
    }
  }
}
