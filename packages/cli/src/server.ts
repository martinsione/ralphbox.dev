import type { AgentType } from "@ralphbox/core/types";
import { publish, subscribe, type BusEvent } from "@ralphbox/core/bus";
import { createRalphboxClient, type RalphboxClient } from "@ralphbox/core/client";
import { writeLock, removeLock } from "@ralphbox/core/server-lock";
import {
  appendChunk,
  createSession,
  getSession,
  listSessions,
  updateSession,
} from "@ralphbox/core/session";
import { createUIMessageStream, type ModelMessage } from "ai";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runAgent, type UIMessage } from "./agent.ts";

const DEFAULT_PORT = 8642;
const DEFAULT_HOSTNAME = process.env.RALPHBOX_SERVER_HOSTNAME ?? "127.0.0.1";
const SERVER_PASSWORD = process.env.RALPHBOX_SERVER_PASSWORD;

const AgentSchema = z.enum(["codex", "claude"]);
const CreateSessionSchema = z.object({ agent: AgentSchema });
const RunSessionSchema = z.object({
  agent: AgentSchema,
  messages: z.array(
    z
      .object({
        role: z.string(),
        content: z.unknown(),
      })
      .passthrough(),
  ),
});

function decodeBasicAuth(authHeader: string): { username: string; password: string } | null {
  if (!authHeader.startsWith("Basic ")) return null;
  const encoded = authHeader.slice("Basic ".length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) return null;
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function isAuthorized(c: Context): boolean {
  if (!SERVER_PASSWORD) return true;
  if (c.req.method === "OPTIONS") return true;
  const token = c.req.query("token");
  if (token && token === SERVER_PASSWORD) return true;
  const authHeader = c.req.header("authorization");
  if (!authHeader) return false;
  const decoded = decodeBasicAuth(authHeader);
  if (!decoded) return false;
  return decoded.password === SERVER_PASSWORD;
}

function unauthorized(c: Context) {
  return c.json({ error: "Unauthorized" }, 401, {
    "WWW-Authenticate": 'Basic realm="ralphbox"',
  });
}

async function parseJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

export const app = new Hono()
  .use(async (c, next) => {
    if (!isAuthorized(c)) {
      return unauthorized(c);
    }
    await next();
  })
  .use(
    cors({
      origin: (origin) => {
        if (!origin) return undefined;
        if (origin.startsWith("http://localhost:")) return origin;
        if (origin.startsWith("http://127.0.0.1:")) return origin;
        return undefined;
      },
    }),
  )
  .get("/api/health", async (c) => {
    return c.json({ healthy: true });
  })
  .get("/api/sessions", async (c) => {
    const sessions = await listSessions();
    return c.json(sessions);
  })
  .get("/api/sessions/:id", async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(session);
  })
  .post("/api/sessions", async (c) => {
    const body = await parseJson<{ agent: AgentType }>(c);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = CreateSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
    }
    const session = await createSession(parsed.data.agent);
    return c.json(session);
  })
  .post("/api/sessions/:id/run", async (c) => {
    const sessionId = c.req.param("id");
    const body = await parseJson<{
      agent: AgentType;
      messages: ModelMessage[];
    }>(c);
    if (!body) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = RunSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
    }

    const session = await getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Stream the response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const uiStream = createUIMessageStream<UIMessage>({
          execute: async ({ writer }) => {
            await updateSession(sessionId, { status: "running" });
            publish({
              type: "session.updated",
              properties: { sessionId },
            });

            try {
              const sandbox = await runAgent({
                sessionId,
                sandboxId: session.sandboxId,
                writer,
                agent: parsed.data.agent,
                messages: parsed.data.messages as ModelMessage[],
              });

              await updateSession(sessionId, {
                status: "completed",
                sandboxId: sandbox.sandboxId,
              });
              publish({
                type: "session.updated",
                properties: { sessionId },
              });
            } catch (error) {
              await updateSession(sessionId, { status: "failed" });
              publish({
                type: "session.updated",
                properties: { sessionId },
              });
              throw error;
            }
          },
        });

        for await (const chunk of uiStream) {
          await appendChunk(sessionId, chunk);
          publish({
            type: "session.chunk",
            properties: { sessionId, chunk },
          });
          controller.enqueue(encoder.encode(JSON.stringify(chunk) + "\n"));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      },
    });
  })
  .get("/events", async (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({
          type: "server.connected",
          properties: {},
        } satisfies BusEvent),
      });

      const unsubscribe = subscribe(async (event) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      });

      const heartbeat = setInterval(async () => {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "server.heartbeat",
            properties: {},
          } satisfies BusEvent),
        });
      }, 30_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });

export async function startServer(options?: { port?: number; hostname?: string }) {
  const port = options?.port ?? DEFAULT_PORT;
  const hostname = options?.hostname ?? DEFAULT_HOSTNAME;
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    fetch: app.fetch,
  });

  // Write lock file so other processes can discover the server
  await writeLock(server.port!, hostname, Boolean(SERVER_PASSWORD));

  // Clean up lock file on exit
  const cleanup = async () => {
    await removeLock();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`Server running at http://${hostname}:${server.port}`);
  return server;
}

export async function createRalphbox(options?: {
  port?: number;
  hostname?: string;
}): Promise<{ server: Bun.Server<unknown>; client: RalphboxClient }> {
  const hostname = options?.hostname ?? DEFAULT_HOSTNAME;
  const server = await startServer(options);
  const client = createRalphboxClient({
    baseUrl: `http://${hostname}:${server.port}`,
    password: SERVER_PASSWORD,
  });
  return { server, client };
}
