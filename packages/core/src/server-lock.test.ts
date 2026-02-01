import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeLock, removeLock, readLock, isServerRunning } from "./server-lock.ts";

const RALPHBOX_DIR = join(homedir(), ".ralphbox");
const LOCK_FILE = join(RALPHBOX_DIR, "server.lock");
const BACKUP_LOCK = join(RALPHBOX_DIR, "server.lock.backup");

describe("server-lock", () => {
  beforeEach(async () => {
    // Backup existing lock file if it exists
    try {
      await Bun.$`mv ${LOCK_FILE} ${BACKUP_LOCK}`.quiet();
    } catch {
      // Lock file doesn't exist
    }
  });

  afterEach(async () => {
    // Clean up test lock file
    await rm(LOCK_FILE, { force: true });

    // Restore backup if it exists
    try {
      await Bun.$`mv ${BACKUP_LOCK} ${LOCK_FILE}`.quiet();
    } catch {
      // Backup doesn't exist
    }
  });

  test("writeLock creates a lock file with correct contents", async () => {
    await writeLock(8642);

    const content = await Bun.file(LOCK_FILE).text();
    const lock = JSON.parse(content);

    expect(lock.port).toBe(8642);
    expect(lock.hostname).toBe("127.0.0.1");
    expect(lock.pid).toBe(process.pid);
    expect(lock.startedAt).toBeGreaterThan(0);
    expect(lock.authRequired).toBe(false);
  });

  test("readLock returns lock contents", async () => {
    await writeLock(8642);
    const lock = await readLock();

    expect(lock).not.toBeNull();
    expect(lock!.port).toBe(8642);
    expect(lock!.pid).toBe(process.pid);
    expect(lock!.hostname).toBe("127.0.0.1");
  });

  test("readLock returns null when no lock file exists", async () => {
    await mkdir(RALPHBOX_DIR, { recursive: true });
    const lock = await readLock();
    expect(lock).toBeNull();
  });

  test("removeLock deletes the lock file", async () => {
    await writeLock(8642);
    expect(await Bun.file(LOCK_FILE).exists()).toBe(true);

    await removeLock();
    expect(await Bun.file(LOCK_FILE).exists()).toBe(false);
  });

  test("removeLock doesn't throw when lock file doesn't exist", async () => {
    await mkdir(RALPHBOX_DIR, { recursive: true });
    // Should not throw
    await removeLock();
  });

  test("isServerRunning returns false when no lock file exists", async () => {
    await mkdir(RALPHBOX_DIR, { recursive: true });
    const status = await isServerRunning();
    expect(status.running).toBe(false);
  });

  test("isServerRunning returns false when PID is dead", async () => {
    // Write a lock file with a non-existent PID
    await mkdir(RALPHBOX_DIR, { recursive: true });
    await Bun.write(
      LOCK_FILE,
      JSON.stringify({
        port: 8642,
        hostname: "127.0.0.1",
        pid: 99999,
        startedAt: Date.now(),
        authRequired: false,
      }),
    );

    const status = await isServerRunning();
    expect(status.running).toBe(false);

    // Should also clean up the stale lock file
    expect(await Bun.file(LOCK_FILE).exists()).toBe(false);
  });

  test("isServerRunning returns false when PID exists but server not responding", async () => {
    // Write a lock file with current PID (exists) but server not on that port
    await mkdir(RALPHBOX_DIR, { recursive: true });
    await Bun.write(
      LOCK_FILE,
      JSON.stringify({
        port: 59999,
        hostname: "127.0.0.1",
        pid: process.pid,
        startedAt: Date.now(),
        authRequired: false,
      }),
    );

    const status = await isServerRunning();
    expect(status.running).toBe(false);

    // Should also clean up the stale lock file
    expect(await Bun.file(LOCK_FILE).exists()).toBe(false);
  });
});
