/**
 * This is a script that runs as a binary inside a sandbox
 */
import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import { codexCli } from "ai-sdk-provider-codex-cli";
import { $ } from "bun";

import { parseCliArgs } from "../src/args";

function log(data: Record<string, any>) {
  console.log(JSON.stringify({ type: "data-sandbox", data }));
}

async function getCliPath({ cliName, npmPackage }: { cliName: string; npmPackage: string }) {
  let path = (await $`sudo which ${cliName}`.nothrow().text()).trim();
  if (!path) {
    log({ text: `Installing ${cliName} CLI...` });
    await $`sudo npm install -g ${npmPackage}`.quiet();
    path = (await $`sudo which ${cliName}`.text()).trim();
  }
  return path;
}

async function getAgent(agent: "codex" | "claude") {
  switch (agent) {
    case "claude": {
      const path = await getCliPath({ cliName: "claude", npmPackage: "@anthropic-ai/claude-code" });
      return claudeCode("opus", {
        pathToClaudeCodeExecutable: path,
        permissionMode: "bypassPermissions",
      });
    }

    case "codex": {
      const path = await getCliPath({ cliName: "codex", npmPackage: "@openai/codex" });
      return codexCli("gpt-5.2-codex", {
        codexPath: path,
        dangerouslyBypassApprovalsAndSandbox: true,
      });
    }

    default:
      throw new Error(`Invalid agent: ${agent}`);
  }
}

async function main() {
  log({ text: "Starting agent..." });

  const args = parseCliArgs();
  const result = streamText({
    model: await getAgent(args.agent),
    messages: args.messages,
  });

  for await (const chunk of result.toUIMessageStream()) {
    console.log(JSON.stringify(chunk));
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(() => {
    process.exit(1);
  });
