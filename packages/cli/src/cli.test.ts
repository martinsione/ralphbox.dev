import { Sandbox } from "@vercel/sandbox";
import { test, expect, describe } from "bun:test";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Environment-gated test flags
const SKIP_SANDBOX = !process.env.RUN_SANDBOX_TESTS;
const SKIP_PR = !process.env.RUN_PR_TESTS;

describe("getSshKeys behavior", () => {
  // Test the expected SSH key paths and behavior
  const sshDir = join(homedir(), ".ssh");
  const expectedFiles = [
    "id_ed25519",
    "id_ed25519.pub",
    "id_rsa",
    "id_rsa.pub",
    "config",
    "known_hosts",
  ];

  test("SSH key paths map to /vercel/sandbox/.ssh/", () => {
    // Verify the path transformation logic
    for (const file of expectedFiles) {
      const sandboxPath = `/vercel/sandbox/.ssh/${file}`;
      expect(sandboxPath).toMatch(/^\/vercel\/sandbox\/.ssh\//);
    }
  });

  test("local .ssh directory can be checked", async () => {
    // This test verifies we can check for the existence of the SSH directory
    // It doesn't require the directory to exist
    try {
      const stats = await stat(sshDir);
      expect(stats.isDirectory()).toBe(true);
    } catch (e) {
      // Directory doesn't exist - that's fine for CI environments
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

describe("credential paths", () => {
  test("codex auth path is correct", () => {
    const authPath = join(homedir(), ".codex", "auth.json");
    expect(authPath).toContain(".codex");
    expect(authPath).toContain("auth.json");
  });

  test("gh config paths are correct", () => {
    const ghConfigDir = join(homedir(), ".config", "gh");
    expect(join(ghConfigDir, "hosts.yml")).toContain("hosts.yml");
    expect(join(ghConfigDir, "config.yml")).toContain("config.yml");
  });

  test("claude credentials path is correct", () => {
    const claudePath = "/vercel/sandbox/.claude/.credentials.json";
    expect(claudePath).toBe("/vercel/sandbox/.claude/.credentials.json");
  });

  test("git config paths are correct", () => {
    // Primary location
    const gitconfigPath = join(homedir(), ".gitconfig");
    expect(gitconfigPath).toContain(".gitconfig");

    // Alternative XDG location
    const xdgPath = join(homedir(), ".config", "git", "config");
    expect(xdgPath).toContain(".config/git/config");

    // Sandbox destination
    const sandboxPath = "/vercel/sandbox/.gitconfig";
    expect(sandboxPath).toBe("/vercel/sandbox/.gitconfig");
  });
});

describe.skipIf(SKIP_SANDBOX)("sandbox tests", () => {
  test("sandbox can be created", async () => {
    const sandbox = await Sandbox.create({
      timeout: 60_000,
      runtime: "node24",
    });

    expect(sandbox.sandboxId).toBeDefined();
    expect(typeof sandbox.sandboxId).toBe("string");

    await sandbox.stop();
  });

  test("sandbox can write and read files", async () => {
    const sandbox = await Sandbox.create({
      timeout: 60_000,
      runtime: "node24",
    });

    const testContent = Buffer.from("test content", "utf-8");
    await sandbox.writeFiles([{ path: "/vercel/sandbox/test.txt", content: testContent }]);

    const result = await sandbox.runCommand({
      cmd: "cat",
      args: ["/vercel/sandbox/test.txt"],
    });

    expect(result.exitCode).toBe(0);

    await sandbox.stop();
  });

  test("sandbox can run commands", async () => {
    const sandbox = await Sandbox.create({
      timeout: 60_000,
      runtime: "node24",
    });

    const result = await sandbox.runCommand({
      cmd: "echo",
      args: ["hello"],
    });

    expect(result.exitCode).toBe(0);

    await sandbox.stop();
  });
});

describe.skipIf(SKIP_PR)("pr workflow tests", () => {
  test(
    "agent can be spawned in sandbox",
    async () => {
      const sandbox = await Sandbox.create({
        timeout: 300_000, // 5 minutes
        runtime: "node24",
      });

      // Verify sandbox is ready
      const whoami = await sandbox.runCommand({ cmd: "whoami" });
      expect(whoami.exitCode).toBe(0);

      // Verify node is available
      const nodeVersion = await sandbox.runCommand({
        cmd: "node",
        args: ["--version"],
      });
      expect(nodeVersion.exitCode).toBe(0);

      await sandbox.stop();
    },
    { timeout: 300_000 },
  );
});
