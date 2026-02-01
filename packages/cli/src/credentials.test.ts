import { test, expect, describe } from "bun:test";

import {
  CodexAuthSchema,
  ClaudeAuthSchema,
  parseGhToken,
  injectTokenToHostsYml,
  createMinimalHostsYml,
} from "./credentials";

describe("parseGhToken", () => {
  test("decodes go-keyring-base64 format", () => {
    // "ghp_xxxxx" base64 encoded
    const encoded = Buffer.from("ghp_xxxxx").toString("base64");
    const input = `go-keyring-base64:${encoded}`;
    expect(parseGhToken(input)).toBe("ghp_xxxxx");
  });

  test("returns plain token as-is", () => {
    expect(parseGhToken("ghp_plain")).toBe("ghp_plain");
  });

  test("trims whitespace from plain tokens", () => {
    expect(parseGhToken("  ghp_token  \n")).toBe("ghp_token");
  });

  test("handles base64 encoded token with whitespace", () => {
    const encoded = Buffer.from("ghp_test").toString("base64");
    const input = `  go-keyring-base64:${encoded}\n`;
    expect(parseGhToken(input)).toBe("ghp_test");
  });
});

describe("injectTokenToHostsYml", () => {
  test("injects token after github.com:", () => {
    const input = "github.com:\n    user: foo";
    const result = injectTokenToHostsYml(input, "ghp_xxx");
    expect(result).toBe("github.com:\n    oauth_token: ghp_xxx\n    user: foo");
  });

  test("handles hosts.yml with multiple hosts", () => {
    const input = "github.com:\n    user: foo\ngitlab.com:\n    user: bar";
    const result = injectTokenToHostsYml(input, "ghp_token");
    expect(result).toContain("oauth_token: ghp_token");
    expect(result).toContain("github.com:");
    expect(result).toContain("gitlab.com:");
  });

  test("preserves existing content after injection", () => {
    const input = "github.com:\n    git_protocol: https\n    user: testuser";
    const result = injectTokenToHostsYml(input, "ghp_abc");
    expect(result).toContain("git_protocol: https");
    expect(result).toContain("user: testuser");
    expect(result).toContain("oauth_token: ghp_abc");
  });
});

describe("createMinimalHostsYml", () => {
  test("creates valid hosts.yml structure", () => {
    const result = createMinimalHostsYml("ghp_xxx");
    expect(result).toBe("github.com:\n    oauth_token: ghp_xxx\n    git_protocol: https\n");
  });

  test("includes token in output", () => {
    const result = createMinimalHostsYml("ghp_my_token_123");
    expect(result).toContain("oauth_token: ghp_my_token_123");
  });
});

describe("CodexAuthSchema", () => {
  test("accepts valid auth with all fields", () => {
    const valid = {
      OPENAI_API_KEY: "sk-xxx",
      tokens: {
        id_token: "id",
        access_token: "access",
        refresh_token: "refresh",
        account_id: "account",
      },
      last_refresh: "2024-01-01T00:00:00Z",
    };
    const result = CodexAuthSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("accepts null OPENAI_API_KEY", () => {
    const valid = {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id",
        access_token: "access",
        refresh_token: "refresh",
        account_id: "account",
      },
      last_refresh: "2024-01-01T00:00:00Z",
    };
    const result = CodexAuthSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("rejects missing tokens object", () => {
    const invalid = {
      OPENAI_API_KEY: "sk-xxx",
      last_refresh: "2024-01-01T00:00:00Z",
    };
    const result = CodexAuthSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects incomplete tokens object", () => {
    const invalid = {
      OPENAI_API_KEY: "sk-xxx",
      tokens: {
        id_token: "id",
        // missing other required fields
      },
      last_refresh: "2024-01-01T00:00:00Z",
    };
    const result = CodexAuthSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects empty object", () => {
    const result = CodexAuthSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ClaudeAuthSchema", () => {
  test("accepts valid auth with all fields", () => {
    const valid = {
      claudeAiOauth: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 1234567890,
        scopes: ["read", "write"],
        subscriptionType: "pro",
      },
    };
    const result = ClaudeAuthSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("accepts auth without optional subscriptionType", () => {
    const valid = {
      claudeAiOauth: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 1234567890,
        scopes: [],
      },
    };
    const result = ClaudeAuthSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("rejects missing claudeAiOauth", () => {
    const invalid = {
      accessToken: "access",
      refreshToken: "refresh",
    };
    const result = ClaudeAuthSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects missing required fields", () => {
    const invalid = {
      claudeAiOauth: {
        accessToken: "access",
        // missing refreshToken, expiresAt, scopes
      },
    };
    const result = ClaudeAuthSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects empty object", () => {
    const result = ClaudeAuthSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects non-number expiresAt", () => {
    const invalid = {
      claudeAiOauth: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: "not-a-number",
        scopes: [],
      },
    };
    const result = ClaudeAuthSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("rejects non-array scopes", () => {
    const invalid = {
      claudeAiOauth: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 1234567890,
        scopes: "not-an-array",
      },
    };
    const result = ClaudeAuthSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
