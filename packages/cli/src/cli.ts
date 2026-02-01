import type { Session } from "@ralphbox/core/session";
import { parseCliArgs } from "./args.ts";
import { app, startServer } from "./server.ts";

const DEFAULT_SERVER_URL = "http://localhost:8642";

// Check if the server is running
async function isServerRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/sessions`, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

// Create fetch function - uses HTTP if server is running, otherwise in-process
async function createFetch(): Promise<{
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  baseUrl: string;
  mode: "http" | "in-process";
}> {
  // Check if server is already running
  if (await isServerRunning(DEFAULT_SERVER_URL)) {
    console.log(`Connecting to server at ${DEFAULT_SERVER_URL}`);
    return {
      fetch: globalThis.fetch,
      baseUrl: DEFAULT_SERVER_URL,
      mode: "http",
    };
  }

  // Fall back to in-process (server not running)
  console.log("No server running, using in-process mode");
  return {
    fetch: async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      return app.fetch(request);
    },
    baseUrl: "http://localhost",
    mode: "in-process",
  };
}

async function runCli() {
  const args = parseCliArgs();
  const { fetch: apiFetch, baseUrl, mode } = await createFetch();

  // Create session via API
  const createRes = await apiFetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: args.agent }),
  });
  const session = (await createRes.json()) as Session;
  console.log(`Session created: ${session.id} (${mode})`);

  // Run agent via API - streams NDJSON
  const runRes = await apiFetch(`${baseUrl}/api/sessions/${session.id}/run`, {
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
