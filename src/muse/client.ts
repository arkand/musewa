export interface MuseMessage {
  content: string;
  role: "system" | "user" | "assistant";
}

export interface ChatClient {
  chat(messages: MuseMessage[]): Promise<string>;
}

export type MuseErrorKind = "http" | "network" | "timeout" | "shape";

export class MuseError extends Error {
  readonly kind: MuseErrorKind;
  readonly status?: number;

  constructor(
    message: string,
    kind: MuseErrorKind,
    status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MuseError";
    this.kind = kind;
    this.status = status;
  }
}

export interface MuseClientOptions {
  apiKey?: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model: string;
  timeoutMs: number;
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
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

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
          body: JSON.stringify({
            messages,
            model: this.options.model,
            stream: false,
          }),
          headers,
          method: "POST",
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

      const payload = (await response.json().catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }

        throw new MuseError("Muse returned invalid JSON", "shape");
      })) as ChatCompletionResponse;
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
        throw new MuseError("Muse request timed out", "timeout", undefined, {
          cause: error,
        });
      }

      throw new MuseError(
        error instanceof Error ? error.message : String(error),
        "network",
        undefined,
        { cause: error instanceof Error ? error : undefined }
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
