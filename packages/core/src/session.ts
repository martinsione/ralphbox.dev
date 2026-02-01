import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STORAGE_DIR = join(homedir(), ".ralphbox");

export type SessionStatus = "created" | "planning" | "running" | "completed" | "failed" | "aborted";

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
  agent: "codex" | "claude";
  sandboxId?: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
};

type StreamState = {
  currentMessageId: string | null;
  activeTextParts: Record<string, { index: number }>;
};

function generateId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureStorageDir(): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return join(STORAGE_DIR, `${id}.json`);
}

function statePath(sessionId: string): string {
  return join(STORAGE_DIR, `${sessionId}.state.json`);
}

export async function createSession(agent: "codex" | "claude"): Promise<Session> {
  await ensureStorageDir();

  const session: Session = {
    id: generateId(),
    status: "created",
    agent,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };

  const state: StreamState = {
    currentMessageId: null,
    activeTextParts: {},
  };

  await Promise.all([
    Bun.write(sessionPath(session.id), JSON.stringify(session, null, 2)),
    Bun.write(statePath(session.id), JSON.stringify(state)),
  ]);

  return session;
}

export async function appendChunk(sessionId: string, chunk: any): Promise<void> {
  const path = sessionPath(sessionId);
  const sPath = statePath(sessionId);

  const [sessionContent, stateContent] = await Promise.all([
    Bun.file(path).text(),
    Bun.file(sPath).text(),
  ]);

  const session: Session = JSON.parse(sessionContent);
  const state: StreamState = JSON.parse(stateContent);

  // Process chunk based on type
  switch (chunk.type) {
    case "start": {
      const messageId = chunk.messageId || `msg-${Date.now()}`;
      state.currentMessageId = messageId;
      session.messages.push({
        id: messageId,
        role: "assistant",
        parts: [],
      });
      break;
    }

    case "text-start": {
      const msg = session.messages.find((m) => m.id === state.currentMessageId);
      if (msg) {
        const idx = msg.parts.push({ type: "text", text: "" }) - 1;
        state.activeTextParts[chunk.id] = { index: idx };
      }
      break;
    }

    case "text-delta": {
      const msg = session.messages.find((m) => m.id === state.currentMessageId);
      const partInfo = state.activeTextParts[chunk.id];
      if (msg && partInfo) {
        const part = msg.parts[partInfo.index];
        if (part?.type === "text") {
          part.text += chunk.delta;
        }
      }
      break;
    }

    case "text-end": {
      delete state.activeTextParts[chunk.id];
      break;
    }

    case "finish": {
      state.currentMessageId = null;
      state.activeTextParts = {};
      break;
    }
  }

  session.updatedAt = Date.now();

  await Promise.all([
    Bun.write(path, JSON.stringify(session, null, 2)),
    Bun.write(sPath, JSON.stringify(state)),
  ]);
}

export async function updateSession(
  sessionId: string,
  updates: Partial<Pick<Session, "status" | "sandboxId">>,
): Promise<void> {
  const path = sessionPath(sessionId);
  const content = await Bun.file(path).text();
  const session: Session = JSON.parse(content);

  Object.assign(session, updates, { updatedAt: Date.now() });

  await Bun.write(path, JSON.stringify(session, null, 2));
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const file = Bun.file(sessionPath(sessionId));
  if (!(await file.exists())) return null;

  const content = await file.text();
  return JSON.parse(content);
}

export async function listSessions(): Promise<Omit<Session, "messages">[]> {
  await ensureStorageDir();

  const glob = new Bun.Glob("*.json");
  const sessions: Omit<Session, "messages">[] = [];

  for await (const file of glob.scan(STORAGE_DIR)) {
    if (file.endsWith(".state.json")) continue;
    try {
      const content = await Bun.file(join(STORAGE_DIR, file)).text();
      const session = JSON.parse(content);
      // Don't include messages in list to keep it light
      const { messages, ...rest } = session;
      sessions.push(rest);
    } catch {
      // Skip invalid files
    }
  }

  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}
