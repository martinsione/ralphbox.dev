import { z } from "zod";

// Schemas for credential validation
export const CodexAuthSchema = z.object({
  OPENAI_API_KEY: z.string().nullable(),
  tokens: z.object({
    id_token: z.string(),
    access_token: z.string(),
    refresh_token: z.string(),
    account_id: z.string(),
  }),
  last_refresh: z.string(),
});

export const ClaudeAuthSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number(),
    scopes: z.array(z.string()),
    subscriptionType: z.string().optional(),
  }),
});

export type CodexAuth = z.infer<typeof CodexAuthSchema>;
export type ClaudeAuth = z.infer<typeof ClaudeAuthSchema>;

/**
 * Parse a GitHub token from keychain format.
 * macOS gh CLI stores tokens as "go-keyring-base64:<base64-encoded-token>"
 */
export function parseGhToken(keychainValue: string): string {
  const trimmed = keychainValue.trim();
  if (trimmed.startsWith("go-keyring-base64:")) {
    const base64Token = trimmed.replace("go-keyring-base64:", "");
    return Buffer.from(base64Token, "base64").toString("utf-8");
  }
  return trimmed;
}

/**
 * Inject an oauth_token into an existing hosts.yml content.
 * Adds the token right after the "github.com:" line.
 */
export function injectTokenToHostsYml(hostsContent: string, token: string): string {
  return hostsContent.replace(/^(github\.com:)/m, `$1\n    oauth_token: ${token}`);
}

/**
 * Create a minimal hosts.yml with just the token and git protocol.
 */
export function createMinimalHostsYml(token: string): string {
  return `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n`;
}
