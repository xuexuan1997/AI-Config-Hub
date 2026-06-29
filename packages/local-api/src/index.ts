import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  API_COMMAND_NAMES,
  createCommandHandlers,
  type ApiCommandName,
  type ApiFailure,
  type CommandServiceMap,
  type TaskEvent,
} from "@ai-config-hub/api";
import { CorrelationIdSchema, RequestIdSchema, TaskIdSchema } from "@ai-config-hub/shared";

export interface LocalApiTaskEventPort {
  subscribe(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void;
}

export interface LocalApiServerOptions {
  readonly services: CommandServiceMap;
  readonly taskEvents?: LocalApiTaskEventPort;
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowUnsafeRemote?: boolean;
}

export interface LocalApiServer {
  readonly url: string;
  readonly authToken: string;
  stop(): Promise<void>;
}

const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const commandNames = new Set<string>(API_COMMAND_NAMES);
const noStoreHeaders = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
} as const;

export async function startLocalApiServer(options: LocalApiServerOptions): Promise<LocalApiServer> {
  const host = options.host ?? "127.0.0.1";
  validateBindHost(host, options.allowUnsafeRemote === true);

  const authToken = options.authToken ?? randomBytes(32).toString("base64url");
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const handlers = createCommandHandlers(options.services);
  const sseClients = new Map<
    number,
    { readonly response: ServerResponse; readonly close: () => void }
  >();
  let nextClientId = 0;
  let stopped = false;

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      host,
      authToken,
      allowedOrigins,
      handlers,
      taskEvents: options.taskEvents,
      sseClients,
      nextClientId: () => nextClientId++,
    });
  });

  await listen(server, options.port ?? 0, host);

  return {
    url: `http://${formatUrlHost(host)}:${addressPort(server)}`,
    authToken,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const client of sseClients.values()) {
        client.close();
        client.response.end();
      }
      sseClients.clear();
      await close(server);
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly host: string;
    readonly authToken: string;
    readonly allowedOrigins: Set<string>;
    readonly handlers: ReturnType<typeof createCommandHandlers>;
    readonly taskEvents: LocalApiTaskEventPort | undefined;
    readonly sseClients: Map<
      number,
      { readonly response: ServerResponse; readonly close: () => void }
    >;
    readonly nextClientId: () => number;
  },
): Promise<void> {
  setNoStore(response);

  const url = new URL(request.url ?? "/", `http://${formatUrlHost(input.host)}`);
  if (!isOriginAllowed(request.headers.origin, input.allowedOrigins)) {
    writeFailure(
      response,
      403,
      failure("request:invalid", "PERMISSION_DENIED", "Origin is not allowed"),
    );
    return;
  }
  writeCorsHeaders(response, request.headers.origin);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (!isAuthorized(request.headers.authorization, input.authToken)) {
    writeFailure(
      response,
      401,
      failure("request:invalid", "PERMISSION_DENIED", "Bearer token is missing or invalid"),
    );
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/command/")) {
    await handleCommandRequest(response, url, request, input.handlers);
    return;
  }

  if (request.method === "GET" && /^\/api\/tasks\/[^/]+\/events$/.test(url.pathname)) {
    handleTaskEventsRequest(
      response,
      url,
      input.taskEvents,
      input.sseClients,
      input.nextClientId(),
    );
    return;
  }

  writeFailure(response, 404, failure("request:invalid", "NOT_FOUND", "API route was not found"));
}

export function validateBindHost(host: string, allowUnsafeRemote = false): void {
  if (allowUnsafeRemote || localHosts.has(host)) return;
  throw new Error(`UNSAFE_BIND_HOST: ${host}`);
}

async function handleCommandRequest(
  response: ServerResponse,
  url: URL,
  request: IncomingMessage,
  handlers: ReturnType<typeof createCommandHandlers>,
): Promise<void> {
  const name = decodeURIComponent(url.pathname.slice("/api/command/".length));
  const body = await readJson(request);
  const requestId = readRequestIdFromUnknown(body);
  if (!commandNames.has(name)) {
    writeFailure(response, 404, failure(requestId, "NOT_FOUND", "Command is not registered"));
    return;
  }

  const result = await handlers[name as ApiCommandName](body);
  const status = result.ok ? 200 : result.error.code === "VALIDATION_FAILED" ? 400 : 500;
  writeJson(response, status, result);
}

function handleTaskEventsRequest(
  response: ServerResponse,
  url: URL,
  taskEvents: LocalApiTaskEventPort | undefined,
  sseClients: Map<number, { readonly response: ServerResponse; readonly close: () => void }>,
  clientId: number,
): void {
  if (taskEvents === undefined) {
    writeFailure(
      response,
      404,
      failure("request:invalid", "NOT_FOUND", "Task events are unavailable"),
    );
    return;
  }

  const taskId = TaskIdSchema.safeParse(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
  const afterSequence = parseAfterSequence(url.searchParams.get("afterSequence"));
  if (!taskId.success || afterSequence === undefined) {
    writeFailure(
      response,
      400,
      failure("request:invalid", "VALIDATION_FAILED", "Task event request is invalid"),
    );
    return;
  }

  response.writeHead(200, {
    ...noStoreHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();

  const unsubscribe = taskEvents.subscribe(taskId.data, afterSequence, (event) => {
    response.write(`event: task\ndata: ${JSON.stringify(event)}\n\n`);
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    sseClients.delete(clientId);
  };
  sseClients.set(clientId, { response, close });
  response.on("close", close);
}

function isAuthorized(header: string | undefined, authToken: string): boolean {
  return header === `Bearer ${authToken}`;
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  return origin === undefined || allowedOrigins.has(origin);
}

function parseAfterSequence(raw: string | null): number | undefined {
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function setNoStore(response: ServerResponse): void {
  for (const [name, value] of Object.entries(noStoreHeaders)) response.setHeader(name, value);
}

function writeCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  if (origin !== undefined) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function writeFailure(response: ServerResponse, status: number, body: ApiFailure): void {
  writeJson(response, status, body);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function failure(
  requestId: string,
  code: ApiFailure["error"]["code"],
  message: string,
): ApiFailure {
  return {
    apiVersion: 1,
    requestId: RequestIdSchema.parse(requestId),
    ok: false,
    error: {
      code,
      message,
      retryable: false,
      action: "Review the request and retry",
      correlationId: CorrelationIdSchema.parse("correlation:local-api"),
    },
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = chunk as Buffer | string;
    chunks.push(typeof value === "string" ? Buffer.from(value) : value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function readRequestIdFromUnknown(input: unknown): string {
  if (typeof input === "object" && input !== null && "requestId" in input) {
    const parsed = RequestIdSchema.safeParse(input.requestId);
    if (parsed.success) return parsed.data;
  }
  return "request:invalid";
}

function formatUrlHost(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

function addressPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("LOCAL_API_PORT_UNAVAILABLE");
  return address.port;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
