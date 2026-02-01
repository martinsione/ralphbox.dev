import type { AgentType } from "@ralphbox/core/types";
import { updateSession } from "@ralphbox/core/session";
import { Sandbox } from "@vercel/sandbox";
import { type ModelMessage, type UIMessage as BaseUIMessage, type UIMessageStreamWriter } from "ai";
import { $ } from "bun";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeAuthSchema,
  CodexAuthSchema,
  createMinimalHostsYml,
  injectTokenToHostsYml,
  parseGhToken,
} from "./credentials.ts";

type UIMessageMetadata = never;
type UIMessageDataParts = {
  sessionId: { id: string };
  sandboxId: { id: string; type: "create" | "get" };
  sandbox: { text: string };
};
type UIMessageTools = never;
export type UIMessage = BaseUIMessage<UIMessageMetadata, UIMessageDataParts, UIMessageTools>;

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
  try {
    return await readFile(join(homedir(), ".gitconfig"));
  } catch {
    try {
      return await readFile(join(homedir(), ".config", "git", "config"));
    } catch {
      return null;
    }
  }
}

async function getSshKeys(): Promise<{
  files: Array<{ path: string; content: Buffer }>;
  names: string[];
}> {
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
  const names: string[] = [];

  for (const file of filesToCopy) {
    try {
      const content = await readFile(join(sshDir, file));
      results.push({ path: `/vercel/sandbox/.ssh/${file}`, content });
      names.push(file);
    } catch {
      // File doesn't exist, skip
    }
  }

  return { files: results, names };
}

async function getGhAuth(): Promise<{ hostsYml: Buffer; configYml: Buffer | null } | null> {
  try {
    const tokenResult = await $`security find-generic-password -s "gh:github.com" -w`
      .nothrow()
      .text();
    if (!tokenResult || tokenResult.includes("could not be found")) {
      return null;
    }

    const token = parseGhToken(tokenResult);

    const ghConfigDir = join(homedir(), ".config", "gh");
    let hostsContent: string;
    try {
      const existingHosts = await readFile(join(ghConfigDir, "hosts.yml"), "utf-8");
      hostsContent = injectTokenToHostsYml(existingHosts, token);
    } catch {
      hostsContent = createMinimalHostsYml(token);
    }

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

    return Buffer.from(result.trim(), "utf-8");
  } catch {
    return null;
  }
}

async function getAgentFileContent() {
  const agentPath = fileURLToPath(import.meta.resolve("../dist/agent"));
  const file = Bun.file(agentPath);
  if (!(await file.exists())) {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const buildResult = await $`bun --filter @ralphbox/cli build:agent`.cwd(repoRoot).nothrow();
    if (buildResult.exitCode !== 0) {
      throw new Error(`Failed to build agent binary (exit ${buildResult.exitCode})`);
    }
  }
  return await readFile(agentPath);
}

const ONE_MINUTE = 60 * 1000;

export async function runAgent({
  sessionId,
  sandboxId,
  writer,
  agent,
  messages,
}: {
  sessionId: string;
  sandboxId?: string;
  writer: UIMessageStreamWriter<UIMessage>;
  agent: AgentType;
  messages: ModelMessage[];
}): Promise<Sandbox> {
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
  let sshKeyNames: string[] = [];

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
        filesToWrite.push({ path: "/vercel/sandbox/.claude/.credentials.json", content: buffer });
      }
    }),
    getSshKeys().then((keys) => {
      if (keys.files.length > 0) {
        writer.write({ type: "data-sandbox", data: { text: `Copying SSH keys...` } });
        filesToWrite.push(...keys.files);
        hasSshKeys = true;
        sshKeyNames = keys.names;
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

  if (hasSshKeys) {
    writer.write({ type: "data-sandbox", data: { text: `Setting SSH key permissions...` } });
    await sandbox.runCommand({
      cmd: "chmod",
      args: ["700", "/vercel/sandbox/.ssh"],
    });
    const privateKeys = sshKeyNames
      .filter((name) => name === "id_ed25519" || name === "id_rsa")
      .map((name) => `/vercel/sandbox/.ssh/${name}`);
    const publicAndConfig = sshKeyNames
      .filter(
        (name) =>
          name === "id_ed25519.pub" ||
          name === "id_rsa.pub" ||
          name === "config" ||
          name === "known_hosts",
      )
      .map((name) => `/vercel/sandbox/.ssh/${name}`);

    if (privateKeys.length > 0) {
      await sandbox.runCommand({
        cmd: "chmod",
        args: ["600", ...privateKeys],
      });
    }
    if (publicAndConfig.length > 0) {
      await sandbox.runCommand({
        cmd: "chmod",
        args: ["644", ...publicAndConfig],
      });
    }
  }

  const ghCheck = await sandbox.runCommand({ cmd: "which", args: ["gh"] });
  if (ghCheck.exitCode !== 0) {
    writer.write({ type: "data-sandbox", data: { text: `Installing gh CLI...` } });
    const installResult = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        "curl -fsSL https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_amd64.tar.gz | tar xz -C /tmp && sudo mv /tmp/gh_2.63.2_linux_amd64/bin/gh /usr/local/bin/gh",
      ],
      env: { HOME: "/vercel/sandbox" },
    });
    if (installResult.exitCode !== 0) {
      writer.write({
        type: "data-sandbox",
        data: { text: `gh CLI install failed with exit code: ${installResult.exitCode}` },
      });
    }
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
