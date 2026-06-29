import type { ApiTransport } from "@ai-config-hub/api/browser";

export interface LocalApiTransportOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
}

const channelPrefix = "ai-config-hub:v1:";

export function createLocalApiTransport(options: LocalApiTransportOptions): ApiTransport {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;

  return {
    async invoke(channel: string, request: unknown): Promise<unknown> {
      const command = commandNameFromChannel(channel);
      const response = await fetchImpl(
        new URL(`api/command/${encodeURIComponent(command)}`, baseUrl),
        {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${options.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );
      return response.json() as Promise<unknown>;
    },
    subscribeTask(
      taskId: string,
      afterSequence: number,
      listener: (event: unknown) => void,
    ): () => void {
      const controller = new AbortController();
      void readEventStream({
        url: new URL(
          `api/tasks/${encodeURIComponent(taskId)}/events?afterSequence=${afterSequence}`,
          baseUrl,
        ),
        authToken: options.authToken,
        fetch: fetchImpl,
        signal: controller.signal,
        listener,
      });
      return () => controller.abort();
    },
  };
}

function commandNameFromChannel(channel: string): string {
  if (!channel.startsWith(channelPrefix)) throw new Error("LOCAL_API_CHANNEL_UNSUPPORTED");
  return channel.slice(channelPrefix.length);
}

async function readEventStream(input: {
  readonly url: URL;
  readonly authToken: string;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  readonly listener: (event: unknown) => void;
}): Promise<void> {
  try {
    const response = await input.fetch(input.url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: input.signal,
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${input.authToken}`,
      },
    });
    if (response.body === null) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!input.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (data.length > 0) input.listener(JSON.parse(data) as unknown);
      }
    }
  } catch (error) {
    if (!input.signal.aborted) throw error;
  }
}
