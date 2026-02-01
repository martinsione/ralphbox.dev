import type { AgentType } from "@ralphbox/core/types";
import { publish, subscribe, type BusEvent } from "@ralphbox/core/bus";
import { writeLock, removeLock } from "@ralphbox/core/server-lock";
import {
  appendChunk,
  createSession,
  getSession,
  listSessions,
  updateSession,
} from "@ralphbox/core/session";
import { createUIMessageStream, type ModelMessage } from "ai";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { runAgent, type UIMessage } from "./agent.ts";

const DEFAULT_PORT = 8642;

export const app = new Hono()
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
    const body = await c.req.json<{ agent: AgentType }>();
    const session = await createSession(body.agent);
    return c.json(session);
  })
  .post("/api/sessions/:id/run", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{
      agent: AgentType;
      messages: ModelMessage[];
    }>();

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
                agent: body.agent,
                messages: body.messages,
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

export async function startServer(port: number = DEFAULT_PORT) {
  const server = Bun.serve({
    port,
    idleTimeout: 0,
    fetch: app.fetch,
  });

  // Write lock file so other processes can discover the server
  await writeLock(server.port!);

  // Clean up lock file on exit
  const cleanup = async () => {
    await removeLock();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`Server running at http://localhost:${server.port}`);
  return server;
}
