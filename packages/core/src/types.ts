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
  | { type: "finish" };

// Any chunk type - used for bus events where we pass through unknown chunk types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStreamChunk = StreamChunk | { type: string; [key: string]: any };

// Bus event types
export type BusEvent =
  | { type: "session.created"; properties: { sessionId: string } }
  | { type: "session.updated"; properties: { sessionId: string } }
  | { type: "session.chunk"; properties: { sessionId: string; chunk: AnyStreamChunk } }
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> };

// Session types
export type SessionStatus = "created" | "planning" | "running" | "completed" | "failed" | "aborted";

export type AgentType = "codex" | "claude";

export type TextPart = {
  type: "text";
  text: string;
};

export type UIMessage = {
  id: string;
  role: "user" | "assistant";
  parts: TextPart[];
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
