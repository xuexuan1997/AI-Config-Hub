import { createApiClient } from "@ai-config-hub/api/browser";
import { describe, expect, it, vi } from "vitest";

import { createLocalApiTransport } from "./local-transport.js";

describe("local web API transport", () => {
  it("posts command envelopes with bearer auth and lets browser fetch provide Origin", async () => {
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("http://127.0.0.1:49152/api/command/scan.start");
      expect(init?.method).toBe("POST");
      expect(init?.mode).toBe("cors");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer web-token");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("origin")).toBe(false);
      const body = init?.body;
      expect(typeof body).toBe("string");
      expect(JSON.parse(body as string)).toEqual({
        apiVersion: 1,
        requestId: "request:web",
        payload: { mode: "full" },
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            apiVersion: 1,
            requestId: "request:web",
            ok: true,
            data: {
              taskId: "task:web",
              status: "queued",
              acceptedAt: "2026-06-29T08:00:00.000Z",
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const transport = createLocalApiTransport({
      baseUrl: "http://127.0.0.1:49152",
      authToken: "web-token",
      fetch: fetchImpl,
    });
    const client = createApiClient(transport, { requestId: () => "request:web" });

    await expect(client.invoke("scan.start", { mode: "full" })).resolves.toMatchObject({
      ok: true,
      data: { taskId: "task:web" },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("subscribes to task SSE with bearer auth and aborts on unsubscribe", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe(
        "http://127.0.0.1:49152/api/tasks/task%3Aweb/events?afterSequence=4",
      );
      expect(init?.method).toBe("GET");
      expect(init?.mode).toBe("cors");
      signal = init?.signal ?? undefined;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer web-token");
      expect(headers.get("accept")).toBe("text/event-stream");
      expect(headers.has("origin")).toBe(false);
      return Promise.resolve(new Response(new ReadableStream()));
    });
    const transport = createLocalApiTransport({
      baseUrl: "http://127.0.0.1:49152/",
      authToken: "web-token",
      fetch: fetchImpl,
    });

    const unsubscribe = transport.subscribeTask("task:web", 4, vi.fn());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    unsubscribe();

    expect(signal?.aborted).toBe(true);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}
