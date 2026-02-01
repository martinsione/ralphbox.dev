import { test, expect, describe, spyOn, afterEach } from "bun:test";
import { parseCliArgs } from "./args";

describe("parseCliArgs", () => {
  // Capture process.exit calls instead of actually exiting
  let exitSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
    errorSpy?.mockRestore();
  });

  function mockExit(): { exitCode: number | null } {
    const result = { exitCode: null as number | null };
    exitSpy = spyOn(process, "exit").mockImplementation((code) => {
      result.exitCode = code as number;
      throw new Error("process.exit called");
    });
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    return result;
  }

  test("default agent is codex when no --agent flag", () => {
    const result = parseCliArgs([]);
    expect(result.agent).toBe("codex");
  });

  test("--agent claude returns agent='claude'", () => {
    const result = parseCliArgs(["--agent", "claude"]);
    expect(result.agent).toBe("claude");
  });

  test("--agent codex returns agent='codex'", () => {
    const result = parseCliArgs(["--agent", "codex"]);
    expect(result.agent).toBe("codex");
  });

  test("-a claude short flag works", () => {
    const result = parseCliArgs(["-a", "claude"]);
    expect(result.agent).toBe("claude");
  });

  test("invalid agent value exits with code 1", () => {
    const exitResult = mockExit();
    expect(() => parseCliArgs(["--agent", "invalid"])).toThrow("process.exit called");
    expect(exitResult.exitCode).toBe(1);
  });

  test("--message 'hello' returns single user message", () => {
    const result = parseCliArgs(["--message", "hello"]);
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("--messages parses JSON array", () => {
    const messages = JSON.stringify([{ role: "user", content: "hi" }]);
    const result = parseCliArgs(["--messages", messages]);
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("-m short flag for messages works", () => {
    const messages = JSON.stringify([{ role: "user", content: "test" }]);
    const result = parseCliArgs(["-m", messages]);
    expect(result.messages).toEqual([{ role: "user", content: "test" }]);
  });

  test("empty args returns agent='codex' and empty messages", () => {
    const result = parseCliArgs([]);
    expect(result).toEqual({ agent: "codex", messages: [] });
  });

  test("invalid JSON in --messages throws error", () => {
    expect(() => parseCliArgs(["--messages", "not-json"])).toThrow();
  });

  test("multiple messages in array", () => {
    const messages = JSON.stringify([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you" },
    ]);
    const result = parseCliArgs(["--messages", messages]);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(result.messages[2]).toEqual({ role: "user", content: "how are you" });
  });

  test("combines agent and message flags", () => {
    const result = parseCliArgs(["--agent", "claude", "--message", "test"]);
    expect(result.agent).toBe("claude");
    expect(result.messages).toEqual([{ role: "user", content: "test" }]);
  });

  test("combines short flags", () => {
    const messages = JSON.stringify([{ role: "user", content: "hi" }]);
    const result = parseCliArgs(["-a", "claude", "-m", messages]);
    expect(result.agent).toBe("claude");
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
