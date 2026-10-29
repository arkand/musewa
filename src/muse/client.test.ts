import { describe, expect, test } from "bun:test";
import { MuseClient, MuseError } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("MuseClient", () => {
  test("sends the model, messages, and bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      calls.push({ init: init ?? {}, url: String(url) });
      return jsonResponse({ choices: [{ message: { content: " hi " } }] });
    }) as typeof fetch;

    const client = new MuseClient({
      apiKey: "secret",
      baseUrl: "http://muse.local/v1",
      fetchImpl,
      model: "muse-1",
      timeoutMs: 1000,
    });

    const reply = await client.chat([{ content: "hello", role: "user" }]);

    expect(reply).toBe("hi");
    const call0 = calls[0];
    expect(call0?.url).toBe("http://muse.local/v1/chat/completions");
    expect(call0?.init.method).toBe("POST");
    expect((call0?.init.headers as Record<string, string>)?.authorization).toBe(
      "Bearer secret"
    );
    expect(JSON.parse(String(call0?.init.body))).toEqual({
      messages: [{ content: "hello", role: "user" }],
      model: "muse-1",
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
      fetchImpl,
      model: "muse-1",
      timeoutMs: 1000,
    });

    await client.chat([{ content: "hello", role: "user" }]);

    expect(headers.authorization).toBeUndefined();
  });

  test("maps a non-2xx response to an http error", async () => {
    const fetchImpl = (async () =>
      new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      fetchImpl,
      model: "muse-1",
      timeoutMs: 1000,
    });

    await expect(
      client.chat([{ content: "hello", role: "user" }])
    ).rejects.toMatchObject({ kind: "http", status: 502 });
  });

  test("maps an empty reply to a shape error", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        choices: [{ message: { content: "   " } }],
      })) as unknown as typeof fetch;
    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      fetchImpl,
      model: "muse-1",
      timeoutMs: 1000,
    });

    await expect(
      client.chat([{ content: "hello", role: "user" }])
    ).rejects.toBeInstanceOf(MuseError);
  });

  test("maps invalid JSON to a shape error", async () => {
    const fetchImpl = (async () =>
      new Response("not json", {
        headers: { "content-type": "application/json" },
        status: 200,
      })) as unknown as typeof fetch;
    const client = new MuseClient({
      baseUrl: "http://muse.local/v1",
      fetchImpl,
      model: "muse-1",
      timeoutMs: 1000,
    });

    await expect(
      client.chat([{ content: "hello", role: "user" }])
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
      fetchImpl,
      model: "muse-1",
      timeoutMs: 10,
    });

    await expect(
      client.chat([{ content: "hello", role: "user" }])
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
