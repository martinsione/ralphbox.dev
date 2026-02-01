// Tool state machine types
export type ToolStatus = "pending" | "running" | "completed" | "error";

export type ToolState = {
  status: ToolStatus;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  time?: { start: number; end?: number };
};

// Stream chunk types from the agent - known types for type-safe handling
export type StreamChunk =
  | { type: "data-sessionId"; data: { id: string } }
  | { type: "data-sandboxId"; data: { id: string; type: "create" | "get" } }
  | { type: "data-sandbox"; data: { text: string } }
  | { type: "start"; messageId?: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  // Standard tool chunk types
  | { type: "tool-call-start"; id: string; toolName: string }
  | { type: "tool-call-delta"; id: string; delta: string }
  | { type: "tool-call"; id: string; toolName: string; input: Record<string, unknown> }
  | { type: "tool-result"; id: string; output: string }
  | { type: "tool-error"; id: string; error: string }
  // Claude Code agent tool chunk types
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "finish" };

// Any chunk type - used for bus events where we pass through unknown chunk types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStreamChunk = StreamChunk | { type: string; [key: string]: any };

// Bus event types
export type BusEvent =
  | { type: "session.created"; properties: { sessionId: string } }
  | { type: "session.updated"; properties: { sessionId: string } }
  | { type: "session.chunk"; properties: { sessionId: string; chunk: AnyStreamChunk } }
  | { type: "part.updated"; properties: { sessionId: string; part: MessagePart; delta?: string } }
  | { type: "message.created"; properties: { sessionId: string; message: UIMessage } }
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> };

// Session types
export type SessionStatus = "created" | "planning" | "running" | "completed" | "failed" | "aborted";

export type AgentType = "codex" | "claude";

// Message part types
type PartBase = { id: string; messageId: string; createdAt?: number; order?: number };

export type TextPart = PartBase & { type: "text"; text: string };
export type ReasoningPart = PartBase & { type: "reasoning"; text: string };
export type ToolPart = PartBase & {
  type: "tool";
  callId: string;
  toolName: string;
  state: ToolState;
};

export type MessagePart = TextPart | ReasoningPart | ToolPart;

export type UIMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  createdAt?: number;
  order?: number;
};

export type Session = {
  id: string;
  status: SessionStatus;
  agent: AgentType;
  sandboxId?: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
};

export type SessionSummary = Omit<Session, "messages">;
