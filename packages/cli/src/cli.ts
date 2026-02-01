import { createSession, appendChunk, updateSession } from "@ralphbox/core/session";
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
import { parseCliArgs } from "./args";
import {
  CodexAuthSchema,
  ClaudeAuthSchema,
  parseGhToken,
  injectTokenToHostsYml,
  createMinimalHostsYml,
} from "./credentials";

async function getCodexAuth(): Promise<Buffer | null> {
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const content = await readFile(authPath, "utf-8");
    const result = CodexAuthSchema.safeParse(JSON.parse(content));
    if (!result.success) {
      return null;
    }
    return Buffer.from(content, "utf-8");
  } catch {
    return null;
  }
}

async function getGitConfig(): Promise<Buffer | null> {
  // Copy .gitconfig to preserve user.name and user.email for commits
  try {
    return await readFile(join(homedir(), ".gitconfig"));
  } catch {
    // Try alternative location
    try {
      return await readFile(join(homedir(), ".config", "git", "config"));
    } catch {
      return null;
    }
  }
}

async function getSshKeys(): Promise<Array<{ path: string; content: Buffer }>> {
  // Copy SSH keys to the sandbox for git operations
  const sshDir = join(homedir(), ".ssh");
  const filesToCopy = [
    "id_ed25519",
    "id_ed25519.pub",
    "id_rsa",
    "id_rsa.pub",
    "config",
    "known_hosts",
  ];
  const results: Array<{ path: string; content: Buffer }> = [];

  for (const file of filesToCopy) {
    try {
      const content = await readFile(join(sshDir, file));
      results.push({ path: `/vercel/sandbox/.ssh/${file}`, content });
    } catch {
      // File doesn't exist, skip
    }
  }

  return results;
}

async function getGhAuth(): Promise<{ hostsYml: Buffer; configYml: Buffer | null } | null> {
  // gh CLI on macOS stores token in keychain, on Linux it's in hosts.yml
  // We need to extract from keychain and create a hosts.yml with the token embedded
  try {
    const tokenResult = await $`security find-generic-password -s "gh:github.com" -w`
      .nothrow()
      .text();
    if (!tokenResult || tokenResult.includes("could not be found")) {
      return null;
    }

    const token = parseGhToken(tokenResult);

    // Read existing hosts.yml to get user info
    const ghConfigDir = join(homedir(), ".config", "gh");
    let hostsContent: string;
    try {
      const existingHosts = await readFile(join(ghConfigDir, "hosts.yml"), "utf-8");
      hostsContent = injectTokenToHostsYml(existingHosts, token);
    } catch {
      hostsContent = createMinimalHostsYml(token);
    }

    // Try to read config.yml
    let configYml: Buffer | null = null;
    try {
      configYml = await readFile(join(ghConfigDir, "config.yml"));
    } catch {
      // config.yml doesn't exist, skip
    }

    return {
      hostsYml: Buffer.from(hostsContent, "utf-8"),
      configYml,
    };
  } catch {
    return null;
  }
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

    const parsed = ClaudeAuthSchema.safeParse(JSON.parse(result.trim()));
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
  sessionId: { id: string };
  sandboxId: { id: string; type: "create" | "get" };
  sandbox: { text: string };
};
type UIMessageTools = never;
type UIMessage = BaseUIMessage<UIMessageMetadata, UIMessageDataParts, UIMessageTools>;

const ONE_MINUTE = 60 * 1000;

async function runAgent({
  sessionId,
  sandboxId,
  writer,
  agent,
  messages,
}: {
  sessionId: string;
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

  await updateSession(sessionId, { sandboxId: sandbox.sandboxId });

  writer.write({ type: "data-sandbox", data: { text: `Writing files to sandbox...` } });
  const filesToWrite: Array<{ path: string; content: Buffer }> = [];
  let hasSshKeys = false;

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
    getSshKeys().then((files) => {
      if (files.length > 0) {
        writer.write({ type: "data-sandbox", data: { text: `Copying SSH keys...` } });
        filesToWrite.push(...files);
        hasSshKeys = true;
      }
    }),
    getGhAuth().then((auth) => {
      if (auth) {
        writer.write({ type: "data-sandbox", data: { text: `Copying gh CLI credentials...` } });
        filesToWrite.push({ path: "/vercel/sandbox/.config/gh/hosts.yml", content: auth.hostsYml });
        if (auth.configYml) {
          filesToWrite.push({
            path: "/vercel/sandbox/.config/gh/config.yml",
            content: auth.configYml,
          });
        }
      }
    }),
    getGitConfig().then((buffer) => {
      if (buffer) {
        writer.write({ type: "data-sandbox", data: { text: `Copying git config...` } });
        filesToWrite.push({ path: "/vercel/sandbox/.gitconfig", content: buffer });
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

  if (chmodResult.exitCode !== 0) {
    writer.write({
      type: "data-sandbox",
      data: { text: `chmod failed with exit code: ${chmodResult.exitCode}` },
    });
    process.exit(1);
  }

  // Set proper permissions for SSH keys (required for SSH to work)
  if (hasSshKeys) {
    writer.write({ type: "data-sandbox", data: { text: `Setting SSH key permissions...` } });
    await sandbox.runCommand({
      cmd: "chmod",
      args: ["700", "/vercel/sandbox/.ssh"],
    });
    await sandbox.runCommand({
      cmd: "chmod",
      args: ["600", "/vercel/sandbox/.ssh/id_ed25519", "/vercel/sandbox/.ssh/id_rsa"],
    });
    await sandbox.runCommand({
      cmd: "chmod",
      args: [
        "644",
        "/vercel/sandbox/.ssh/id_ed25519.pub",
        "/vercel/sandbox/.ssh/id_rsa.pub",
        "/vercel/sandbox/.ssh/config",
        "/vercel/sandbox/.ssh/known_hosts",
      ],
    });
  }

  // Install gh CLI if not already present (using binary for speed)
  const ghCheck = await sandbox.runCommand({ cmd: "which", args: ["gh"] });
  if (ghCheck.exitCode !== 0) {
    writer.write({ type: "data-sandbox", data: { text: `Installing gh CLI...` } });
    // Download and install gh CLI binary directly (faster than apt)
    await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        "curl -fsSL https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_amd64.tar.gz | tar xz -C /tmp && sudo mv /tmp/gh_2.63.2_linux_amd64/bin/gh /usr/local/bin/gh",
      ],
      env: { HOME: "/vercel/sandbox" },
    });
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

  const logStream = new ReadableStream({
    async start(controller) {
      for await (const log of cmd.logs()) {
        const text = log.data.toString();
        try {
          controller.enqueue(JSON.parse(text));
        } catch {
          controller.enqueue({ type: "data-sandbox", data: { text } });
        }
      }
      controller.close();
    },
  });

  writer.merge(logStream);

  return sandbox;
}

async function main() {
  const args = parseCliArgs();
  const session = await createSession(args.agent);

  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "data-sessionId", data: { id: session.id } });
      await updateSession(session.id, { status: "running" });

      try {
        const sandbox = await runAgent({
          sessionId: session.id,
          writer,
          agent: args.agent,
          messages: args.messages,
        });

        await updateSession(session.id, {
          status: "completed",
          sandboxId: sandbox.sandboxId,
        });
      } catch (error) {
        await updateSession(session.id, { status: "failed" });
        throw error;
      }
    },
  });

  for await (const chunk of stream) {
    await appendChunk(session.id, chunk);
    console.log(JSON.stringify(chunk));
  }
}

await main();
