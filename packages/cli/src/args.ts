import { type ModelMessage } from "ai";
import { parseArgs } from "node:util";
import { z } from "zod";

const ArgsSchema = z.object({
  agent: z.enum(["codex", "claude"]).default("codex"),
  message: z.string().optional(),
  messages: z.string().optional(),
});

export type Agent = z.infer<typeof ArgsSchema>["agent"];

export type ParsedArgs = {
  agent: Agent;
  messages: ModelMessage[];
};

export function parseCliArgs(argv?: string[]): ParsedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      message: { type: "string" },
      messages: { type: "string", short: "m" },
      agent: { type: "string", short: "a" },
    },
  });

  const result = ArgsSchema.safeParse(values);
  if (!result.success) {
    console.error("Invalid arguments:", result.error.issues);
    process.exit(1);
  }

  const { agent, message, messages } = result.data;
  if (message) {
    return { agent, messages: [{ role: "user", content: message }] };
  }

  if (messages) {
    return { agent, messages: JSON.parse(messages) as ModelMessage[] };
  }

  return { agent, messages: [] };
}
