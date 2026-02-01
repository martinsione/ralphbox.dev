import type { Session } from "@ralphbox/core/session";
import { isServerRunning } from "@ralphbox/core/server-lock";
import { parseCliArgs } from "./args.ts";
import { startServer } from "./server.ts";

async function runCli() {
  const args = parseCliArgs();

  // Auto-detect running server, or start one if needed
  let serverUrl = args.attach;
  if (!serverUrl) {
    const serverStatus = await isServerRunning();
    if (serverStatus.running) {
      serverUrl = serverStatus.url;
      console.log(`Connecting to server at ${serverUrl}`);
    } else {
      // Start server so web UI can connect
      const server = await startServer();
      serverUrl = `http://localhost:${server.port}`;
      console.log(`Started server at ${serverUrl}`);
    }
  }

  // Create session via API
  const createRes = await fetch(`${serverUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: args.agent }),
  });
  const session = (await createRes.json()) as Session;
  console.log(`Session created: ${session.id}`);

  // Run agent via API - streams NDJSON
  const runRes = await fetch(`${serverUrl}/api/sessions/${session.id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: args.agent,
      messages: args.messages,
    }),
  });

  if (!runRes.ok) {
    const error = await runRes.json();
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
}

// Handle serve command: bun cli.ts serve [port]
const [command] = process.argv.slice(2);

if (command === "serve") {
  const portArg = process.argv[3];
  const port = portArg ? parseInt(portArg, 10) : undefined;
  startServer(port);
} else {
  await runCli();
}
