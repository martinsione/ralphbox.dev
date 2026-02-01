import { customAlphabet } from "nanoid";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentType,
  AnyStreamChunk,
  MessagePart,
  Session,
  SessionSummary,
  ToolState,
  UIMessage,
} from "./types.ts";
import { publish } from "./bus.ts";

export type { Session, SessionSummary };

const SESSIONS_DIR = join(homedir(), ".ralphbox", "sessions");

type StreamState = {
  currentMessageId: string | null;
  activeParts: Record<string, { partId: string }>;
  toolInputBuffers: Record<string, string>;
  messageIndex: number;
  partIndex: number;
};

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 8);

function generateId(): string {
  return nanoid();
}

async function ensureStorageDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function statePath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.state.json`);
}

function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId);
}

function messageDir(sessionId: string, messageId: string): string {
  return join(sessionDir(sessionId), messageId);
}

function messagePath(sessionId: string, messageId: string): string {
  return join(messageDir(sessionId, messageId), "message.json");
}

function partPath(sessionId: string, messageId: string, partId: string): string {
  return join(messageDir(sessionId, messageId), `${partId}.json`);
}

export async function writePart(sessionId: string, part: MessagePart): Promise<void> {
  const dir = messageDir(sessionId, part.messageId);
  await mkdir(dir, { recursive: true });
  await Bun.write(partPath(sessionId, part.messageId, part.id), JSON.stringify(part, null, 2));
}

export async function readPart(
  sessionId: string,
  messageId: string,
  partId: string,
): Promise<MessagePart | null> {
  const file = Bun.file(partPath(sessionId, messageId, partId));
  if (!(await file.exists())) return null;
  return JSON.parse(await file.text());
}

export async function listParts(sessionId: string, messageId: string): Promise<MessagePart[]> {
  const dir = messageDir(sessionId, messageId);
  try {
    const files = await readdir(dir);
    const parts: MessagePart[] = [];
    for (const file of files) {
      if (file === "message.json" || !file.endsWith(".json")) continue;
      const content = await Bun.file(join(dir, file)).text();
      parts.push(JSON.parse(content));
    }
    return parts.sort((a, b) => {
      const orderA = a.order ?? 0;
      const orderB = b.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.id.localeCompare(b.id);
    });
  } catch {
    return [];
  }
}

async function writeMessage(
  sessionId: string,
  message: Omit<UIMessage, "parts"> & { partIds: string[] },
): Promise<void> {
  const dir = messageDir(sessionId, message.id);
  await mkdir(dir, { recursive: true });
  await Bun.write(messagePath(sessionId, message.id), JSON.stringify(message, null, 2));
}

async function readMessage(
  sessionId: string,
  messageId: string,
): Promise<(Omit<UIMessage, "parts"> & { partIds: string[] }) | null> {
  const file = Bun.file(messagePath(sessionId, messageId));
  if (!(await file.exists())) return null;
  return JSON.parse(await file.text());
}

async function listMessageIds(sessionId: string): Promise<string[]> {
  const dir = sessionDir(sessionId);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function createSession(agent: AgentType): Promise<Session> {
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
    activeParts: {},
    toolInputBuffers: {},
    messageIndex: 0,
    partIndex: 0,
  };

  await Promise.all([
    Bun.write(sessionPath(session.id), JSON.stringify(session, null, 2)),
    Bun.write(statePath(session.id), JSON.stringify(state)),
    mkdir(sessionDir(session.id), { recursive: true }),
  ]);

  publish({ type: "session.created", properties: { sessionId: session.id } });

  return session;
}

async function handleTextLikeStart(
  sessionId: string,
  state: StreamState,
  chunkId: string,
  partType: "text" | "reasoning",
): Promise<void> {
  if (!state.currentMessageId) return;

  const partId = generateId();
  const now = Date.now();
  const order = (state.partIndex += 1);
  const part: MessagePart = {
    id: partId,
    messageId: state.currentMessageId,
    type: partType,
    text: "",
    createdAt: now,
    order,
  };

  state.activeParts[chunkId] = { partId };
  await writePart(sessionId, part);
  publish({ type: "part.updated", properties: { sessionId, part } });
}

async function handleTextLikeDelta(
  sessionId: string,
  state: StreamState,
  chunkId: string,
  delta: string,
  partType: "text" | "reasoning",
): Promise<void> {
  const partInfo = state.activeParts[chunkId];
  if (!partInfo || !state.currentMessageId) return;

  const part = await readPart(sessionId, state.currentMessageId, partInfo.partId);
  if (part?.type === partType) {
    part.text += delta;
    await writePart(sessionId, part);
    publish({ type: "part.updated", properties: { sessionId, part, delta } });
  }
}

async function finalizeToolPart(
  sessionId: string,
  state: StreamState,
  toolId: string,
  status: "completed" | "error",
  result: { output?: string; error?: string },
): Promise<void> {
  const partInfo = state.activeParts[toolId];
  if (!partInfo || !state.currentMessageId) return;

  const part = await readPart(sessionId, state.currentMessageId, partInfo.partId);
  if (part?.type === "tool") {
    part.state.status = status;
    if (result.output !== undefined) part.state.output = result.output;
    if (result.error !== undefined) part.state.error = result.error;
    part.state.time = { ...part.state.time!, end: Date.now() };
    await writePart(sessionId, part);
    publish({ type: "part.updated", properties: { sessionId, part } });
  }

  delete state.activeParts[toolId];
}

export async function appendChunk(sessionId: string, chunk: AnyStreamChunk): Promise<void> {
  const sPath = statePath(sessionId);
  const stateContent = await Bun.file(sPath).text();
  const rawState = JSON.parse(stateContent) as Partial<StreamState>;
  const state: StreamState = {
    currentMessageId: rawState.currentMessageId ?? null,
    activeParts: rawState.activeParts ?? {},
    toolInputBuffers: rawState.toolInputBuffers ?? {},
    messageIndex: rawState.messageIndex ?? 0,
    partIndex: rawState.partIndex ?? 0,
  };

  switch (chunk.type) {
    case "start": {
      const messageId = chunk.messageId || generateId();
      state.currentMessageId = messageId;
      const now = Date.now();
      const order = (state.messageIndex += 1);

      const message: UIMessage = {
        id: messageId,
        role: "assistant",
        parts: [],
        createdAt: now,
        order,
      };

      await writeMessage(sessionId, { ...message, partIds: [] });
      publish({ type: "message.created", properties: { sessionId, message } });
      break;
    }

    case "text-start": {
      await handleTextLikeStart(sessionId, state, chunk.id, "text");
      break;
    }

    case "text-delta": {
      await handleTextLikeDelta(sessionId, state, chunk.id, chunk.delta, "text");
      break;
    }

    case "text-end":
    case "reasoning-end": {
      delete state.activeParts[chunk.id];
      break;
    }

    case "reasoning-start": {
      await handleTextLikeStart(sessionId, state, chunk.id, "reasoning");
      break;
    }

    case "reasoning-delta": {
      await handleTextLikeDelta(sessionId, state, chunk.id, chunk.delta, "reasoning");
      break;
    }

    case "tool-call-start": {
      if (!state.currentMessageId) break;

      const partId = generateId();
      const now = Date.now();
      const order = (state.partIndex += 1);
      const toolState: ToolState = {
        status: "pending",
        input: {},
        time: { start: Date.now() },
      };

      const part: MessagePart = {
        id: partId,
        messageId: state.currentMessageId,
        type: "tool",
        callId: chunk.id,
        toolName: chunk.toolName,
        state: toolState,
        createdAt: now,
        order,
      };

      state.activeParts[chunk.id] = { partId };
      state.toolInputBuffers[chunk.id] = "";
      await writePart(sessionId, part);
      publish({ type: "part.updated", properties: { sessionId, part } });
      break;
    }

    case "tool-call-delta": {
      state.toolInputBuffers[chunk.id] = (state.toolInputBuffers[chunk.id] || "") + chunk.delta;
      break;
    }

    case "tool-call": {
      const partInfo = state.activeParts[chunk.id];
      if (!partInfo || !state.currentMessageId) break;

      const part = await readPart(sessionId, state.currentMessageId, partInfo.partId);
      if (part?.type === "tool") {
        part.state.status = "running";
        part.state.input = chunk.input;
        await writePart(sessionId, part);
        publish({ type: "part.updated", properties: { sessionId, part } });
      }

      delete state.toolInputBuffers[chunk.id];
      break;
    }

    case "tool-result": {
      await finalizeToolPart(sessionId, state, chunk.id, "completed", { output: chunk.output });
      break;
    }

    case "tool-error": {
      await finalizeToolPart(sessionId, state, chunk.id, "error", { error: chunk.error });
      break;
    }

    // Claude Code agent tool chunk types
    case "tool-input-delta": {
      const id = chunk.toolCallId;
      state.toolInputBuffers[id] = (state.toolInputBuffers[id] || "") + chunk.inputTextDelta;
      break;
    }

    case "tool-input-available": {
      if (!state.currentMessageId) break;

      const id = chunk.toolCallId;
      const partId = generateId();
      const now = Date.now();
      const order = (state.partIndex += 1);
      const toolState: ToolState = {
        status: "running",
        input: chunk.input,
        time: { start: Date.now() },
      };

      const part: MessagePart = {
        id: partId,
        messageId: state.currentMessageId,
        type: "tool",
        callId: id,
        toolName: chunk.toolName,
        state: toolState,
        createdAt: now,
        order,
      };

      state.activeParts[id] = { partId };
      delete state.toolInputBuffers[id];
      await writePart(sessionId, part);
      publish({ type: "part.updated", properties: { sessionId, part } });
      break;
    }

    case "tool-output-available": {
      const id = chunk.toolCallId;
      const output = typeof chunk.output === "string" ? chunk.output : JSON.stringify(chunk.output);
      await finalizeToolPart(sessionId, state, id, "completed", { output });
      break;
    }

    case "finish": {
      state.currentMessageId = null;
      state.activeParts = {};
      state.toolInputBuffers = {};
      break;
    }
  }

  await Bun.write(sPath, JSON.stringify(state));
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
  const sessionMeta: Omit<Session, "messages"> = JSON.parse(content);

  const messageIds = await listMessageIds(sessionId);
  const messages: UIMessage[] = [];

  for (const messageId of messageIds) {
    const messageMeta = await readMessage(sessionId, messageId);
    if (!messageMeta) continue;

    const parts = await listParts(sessionId, messageId);
    messages.push({
      id: messageMeta.id,
      role: messageMeta.role,
      parts,
      createdAt: messageMeta.createdAt,
      order: messageMeta.order,
    });
  }

  messages.sort((a, b) => {
    const orderA = a.order ?? 0;
    const orderB = b.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    const timeA = a.createdAt ?? 0;
    const timeB = b.createdAt ?? 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.id.localeCompare(b.id);
  });

  return { ...sessionMeta, messages };
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureStorageDir();

  const glob = new Bun.Glob("*.json");
  const sessions: SessionSummary[] = [];

  for await (const file of glob.scan(SESSIONS_DIR)) {
    if (file.endsWith(".state.json")) continue;
    try {
      const content = await Bun.file(join(SESSIONS_DIR, file)).text();
      const session = JSON.parse(content);
      const { messages, ...rest } = session;
      sessions.push(rest);
    } catch {
      // Skip invalid files
    }
  }

  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export async function migrateV1ToV2(): Promise<void> {
  await ensureStorageDir();

  const glob = new Bun.Glob("*.json");

  for await (const file of glob.scan(SESSIONS_DIR)) {
    if (file.endsWith(".state.json")) continue;

    const sessionId = file.replace(".json", "");
    const dir = sessionDir(sessionId);

    const dirExists = await Bun.file(dir)
      .exists()
      .catch(() => false);
    if (dirExists) continue;

    try {
      const content = await Bun.file(join(SESSIONS_DIR, file)).text();
      const session = JSON.parse(content);

      if (!session.messages || !Array.isArray(session.messages)) continue;

      await mkdir(dir, { recursive: true });

      let messageOrder = 0;
      for (const message of session.messages) {
        const partIds: string[] = [];
        let partOrder = 0;
        messageOrder += 1;

        if (message.parts && Array.isArray(message.parts)) {
          for (const oldPart of message.parts) {
            const partId = generateId();
            partIds.push(partId);
            partOrder += 1;

            const newPart: MessagePart = {
              ...oldPart,
              id: partId,
              messageId: message.id,
              order: partOrder,
              createdAt:
                typeof oldPart.createdAt === "number" ? oldPart.createdAt : Date.now() + partOrder,
            };

            await writePart(sessionId, newPart);
          }
        }

        await writeMessage(sessionId, {
          id: message.id,
          role: message.role,
          partIds,
          order: messageOrder,
          createdAt:
            typeof message.createdAt === "number" ? message.createdAt : Date.now() + messageOrder,
        });
      }

      const { messages, ...sessionMeta } = session;
      await Bun.write(sessionPath(sessionId), JSON.stringify(sessionMeta, null, 2));
    } catch {
      // Skip failed migrations
    }
  }
}
