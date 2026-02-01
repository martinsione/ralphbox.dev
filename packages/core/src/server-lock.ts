import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RALPHBOX_DIR = join(homedir(), ".ralphbox");
const LOCK_FILE = join(RALPHBOX_DIR, "server.lock");

type ServerLock = {
  port: number;
  pid: number;
  startedAt: number;
};

async function ensureDir(): Promise<void> {
  await mkdir(RALPHBOX_DIR, { recursive: true });
}

export async function writeLock(port: number): Promise<void> {
  await ensureDir();
  const lock: ServerLock = {
    port,
    pid: process.pid,
    startedAt: Date.now(),
  };
  await Bun.write(LOCK_FILE, JSON.stringify(lock));
}

export async function removeLock(): Promise<void> {
  try {
    await rm(LOCK_FILE);
  } catch {
    // Ignore if file doesn't exist
  }
}

export async function readLock(): Promise<ServerLock | null> {
  try {
    const file = Bun.file(LOCK_FILE);
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

export async function isServerRunning(): Promise<
  { running: true; url: string } | { running: false }
> {
  const lock = await readLock();
  if (!lock) return { running: false };

  // Check if process is still alive
  try {
    process.kill(lock.pid, 0); // Signal 0 = check if process exists
  } catch {
    // Process is dead, clean up stale lock
    await removeLock();
    return { running: false };
  }

  // Verify server is actually responding
  try {
    const res = await fetch(`http://localhost:${lock.port}/api/sessions`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      return { running: true, url: `http://localhost:${lock.port}` };
    }
    // Server responded but not OK, clean up stale lock
    await removeLock();
    return { running: false };
  } catch {
    // Server not responding, clean up stale lock
    await removeLock();
    return { running: false };
  }
}
