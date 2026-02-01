import type { Session } from "@ralphbox/core/session";
import { createRalphboxClient } from "@ralphbox/core/client";
import { isServerRunning, removeLock } from "@ralphbox/core/server-lock";
import { parseArgs } from "node:util";
import { parseCliArgs } from "./args.ts";
import { startServer } from "./server.ts";

async function runCli() {
  const args = parseCliArgs();

  // Auto-detect running server, or start one if needed
  let serverUrl = args.attach;
  let startedServer: Bun.Server<unknown> | null = null;
  if (!serverUrl) {
    const serverStatus = await isServerRunning();
    if (serverStatus.running) {
      serverUrl = serverStatus.url;
      console.log(`Connecting to server at ${serverUrl}`);
    } else {
      // Start server so web UI can connect
      const server = await startServer();
      startedServer = server;
      serverUrl = `http://127.0.0.1:${server.port}`;
      console.log(`Started server at ${serverUrl}`);
    }
  }

  if (!serverUrl) {
    console.error("Failed to determine server URL");
    process.exit(1);
  }

  const client = createRalphboxClient({
    baseUrl: serverUrl,
    password: process.env.RALPHBOX_SERVER_PASSWORD,
  });

  // Create session via API
  let session: Session;
  try {
    session = (await client.sessions.create(args.agent)) as Session;
  } catch (error) {
    console.error("Failed to create session:", error);
    process.exit(1);
  }
  console.log(`Session created: ${session.id}`);

  // Run agent via API - streams NDJSON
  const runRes = await client.sessions.run(session.id, {
    agent: args.agent,
    messages: args.messages,
  });

  if (!runRes.ok) {
    const error = await runRes.json().catch(() => ({ error: "Unknown error" }));
    console.error("Error:", error);
    process.exit(1);
  }

  // Stream the response
  const reader = runRes.body?.getReader();
  if (!reader) {
    console.error("No response body");
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        console.log(line);
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    console.log(buffer);
  }

  if (startedServer) {
    startedServer.stop(true);
    await removeLock();
  }
}

// Handle serve command: bun cli.ts serve [port]
const [command, ...rest] = process.argv.slice(2);

if (command === "serve") {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      hostname: { type: "string" },
    },
  });
  const portArg = values.port ?? positionals[0];
  const port = portArg ? parseInt(portArg, 10) : undefined;
  if (portArg && Number.isNaN(port)) {
    console.error(`Invalid port: ${portArg}`);
    process.exit(1);
  }
  startServer({ port, hostname: values.hostname });
} else {
  await runCli();
}
