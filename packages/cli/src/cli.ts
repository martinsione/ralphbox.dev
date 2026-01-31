import { Sandbox } from "@vercel/sandbox";
import {
  createUIMessageStream,
  type UIMessageStreamWriter,
  type UIMessage as BaseUIMessage,
  type ModelMessage,
} from "ai";
import { $ } from "bun";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { parseCliArgs } from "./args";

async function getCodexAuth() {
  const schema = z.object({
    OPENAI_API_KEY: z.string().nullable(),
    tokens: z.object({
      id_token: z.string(),
      access_token: z.string(),
      refresh_token: z.string(),
      account_id: z.string(),
    }),
    last_refresh: z.string(),
  });

  const authPath = join(homedir(), ".codex", "auth.json");
  const content = await readFile(authPath, "utf-8");
  const result = schema.safeParse(JSON.parse(content));
  if (!result.success) {
    return null;
  }
  return Buffer.from(content, "utf-8");
}

async function getClaudeAuth(): Promise<Buffer | null> {
  // Claude Code stores OAuth credentials in macOS Keychain with service name "Claude Code-credentials"
  // On Linux (which the sandbox uses), credentials are read from ~/.claude/.credentials.json
  // We read from keychain and return the JSON to be written to the credentials file in the sandbox
  try {
    const result = await $`security find-generic-password -s "Claude Code-credentials" -w`
      .nothrow()
      .text();
    if (!result || result.includes("could not be found")) {
      return null;
    }

    const schema = z.object({
      claudeAiOauth: z.object({
        accessToken: z.string(),
        refreshToken: z.string(),
        expiresAt: z.number(),
        scopes: z.array(z.string()),
        subscriptionType: z.string().optional(),
      }),
    });

    const parsed = schema.safeParse(JSON.parse(result.trim()));
    if (!parsed.success) {
      return null;
    }

    // Return the full credentials JSON as a buffer to be written to the sandbox
    return Buffer.from(result.trim(), "utf-8");
  } catch {
    return null;
  }
}

async function getAgentFileContent() {
  const agentPath = fileURLToPath(import.meta.resolve("../dist/agent"));
  return await readFile(agentPath);
}

type UIMessageMetadata = never;
type UIMessageDataParts = {
  sandboxId: { id: string; type: "create" | "get" };
  sandbox: { text: string };
};
type UIMessageTools = never;
type UIMessage = BaseUIMessage<UIMessageMetadata, UIMessageDataParts, UIMessageTools>;

const ONE_MINUTE = 60 * 1000;

async function runAgent({
  sandboxId,
  writer,
  agent,
  messages,
}: {
  sandboxId?: string;
  writer: UIMessageStreamWriter<UIMessage>;
  agent: "codex" | "claude";
  messages: ModelMessage[];
}) {
  let sandbox: Sandbox | null = null;

  if (sandboxId) {
    sandbox = await Sandbox.get({ sandboxId });
    writer.write({ type: "data-sandboxId", data: { id: sandbox.sandboxId, type: "get" } });
  }

  if (!sandbox) {
    sandbox = await Sandbox.create({ timeout: ONE_MINUTE * 60, runtime: "node24" });
    writer.write({ type: "data-sandboxId", data: { id: sandbox.sandboxId, type: "create" } });
  }

  writer.write({ type: "data-sandbox", data: { text: `Writing files to sandbox...` } });
  const filesToWrite: Array<{ path: string; content: Buffer }> = [];

  await Promise.all([
    getCodexAuth().then((buffer) => {
      if (buffer) {
        writer.write({ type: "data-sandbox", data: { text: `Copying Codex credentials...` } });
        filesToWrite.push({ path: "/vercel/sandbox/.codex/auth.json", content: buffer });
      }
    }),
    getClaudeAuth().then((buffer) => {
      if (buffer) {
        writer.write({ type: "data-sandbox", data: { text: `Copying Claude credentials...` } });
        // On Linux, Claude Code reads credentials from ~/.claude/.credentials.json
        filesToWrite.push({ path: "/vercel/sandbox/.claude/.credentials.json", content: buffer });
      }
    }),
    getAgentFileContent().then((buffer) => {
      filesToWrite.push({ path: "/vercel/sandbox/agent", content: buffer });
    }),
  ]);
  await sandbox.writeFiles(filesToWrite);

  writer.write({ type: "data-sandbox", data: { text: `Making binary executable...` } });
  const chmodResult = await sandbox.runCommand({
    cmd: "chmod",
    args: ["+x", "/vercel/sandbox/agent"],
    stderr: process.stderr,
    stdout: process.stdout,
  });

  if (chmodResult.exitCode != 0) {
    writer.write({
      type: "data-sandbox",
      data: { text: `chmod failed with exit code: ${chmodResult.exitCode}` },
    });
    process.exit(1);
  }

  writer.write({ type: "data-sandbox", data: { text: `Running agent (${agent})...` } });
  const cmd = await sandbox.runCommand({
    cmd: "/vercel/sandbox/agent",
    args: ["--agent", agent, "--messages", JSON.stringify(messages)],
    env: {
      HOME: "/vercel/sandbox",
    },
    detached: true,
  });

  for await (const log of cmd.logs()) {
    const text = log.data.toString();
    try {
      const chunk = JSON.parse(text);
      writer.write(chunk);
    } catch {
      writer.write({ type: "data-sandbox", data: { text } });
    }
  }

  writer.write({ type: "data-sandbox", data: { text: `Agent execution successful` } });
  return sandbox;
}

async function main() {
  const args = parseCliArgs();
  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      await runAgent({
        sandboxId: "sbx_8XKIb0E6EmVPhAlA9Aq6s1PLuSXV",
        writer,
        agent: args.agent,
        messages: args.messages,
      });
    },
  });

  for await (const chunk of stream) {
    console.log(JSON.stringify(chunk));
  }
}

await main();
