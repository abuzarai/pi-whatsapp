/**
 * Shared helpers for the WhatsApp extension.
 */

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Split a reply into API-sized parts. The platform caps text at 4096 characters;
 * 4000 leaves room for multi-byte characters. Prefers paragraph, then line, then
 * word boundaries.
 */
export function chunk(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  if (!rest) return out;

  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    // Never split a surrogate pair: the tail half would be an invalid lone unit.
    const code = rest.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * One session per WhatsApp conversation. The result must satisfy pi's session-id
 * rule: letters, numbers, `.`, `_`, `-`, starting and ending alphanumeric.
 */
export function sessionIdFor(participant: string): string {
  const safe = participant.replace(/[^A-Za-z0-9._-]/g, "-");
  const short = createHash("sha1").update(participant).digest("hex").slice(0, 6);
  return `wa-${safe}-${short}`;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

export function extFromMime(mime = ""): string | null {
  return EXT_BY_MIME[mime] ?? (mime.startsWith("text/") ? "txt" : null);
}

/**
 * The WHATSAPP_AGENT_TOKEN env var, or `token` in a JSON config file.
 * `source` is reported by /whatsapp doctor without ever printing the token.
 */
export async function loadTokenWithSource(
  configPath: string,
): Promise<{ token?: string; source: "env" | "file" | "none" }> {
  const fromEnv = process.env.WHATSAPP_AGENT_TOKEN;
  if (fromEnv) return { token: fromEnv, source: "env" };
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as { token?: string };
    if (parsed.token) return { token: parsed.token, source: "file" };
  } catch {
    // Missing or malformed: treated as no token.
  }
  return { source: "none" };
}

export async function loadToken(configPath: string): Promise<string | undefined> {
  return (await loadTokenWithSource(configPath)).token;
}

// ------------------------------------------------------------------ lockfile

/**
 * Exactly one poller may run per agent: the platform answers a second concurrent
 * poll with 409 and replaces the first. This guards against a second pi session.
 */
export interface LockInfo {
  pid: number;
  kind: string;
  startedAt: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user (pid 1, or a
    // root-owned daemon). Only ESRCH means it is really gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Inspect the lock without taking it, for diagnostics. */
export async function readLock(
  lockPath: string,
): Promise<{ holder?: LockInfo; alive: boolean; ours: boolean }> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return { alive: false, ours: false }; // absent
  }

  try {
    const holder = JSON.parse(raw) as LockInfo;
    return { holder, alive: isAlive(holder.pid), ours: holder.pid === process.pid };
  } catch {
    // Present but unreadable: the writer may be between its exclusive create and
    // its write, so treat it as held rather than dead and stealable.
    return { alive: true, ours: false };
  }
}

/**
 * Media handles are opaque, server-generated strings. They reach a filesystem path
 * and a request URL, so anything that could traverse out of the intended directory
 * is rejected rather than sanitised.
 */
export function isSafeMediaId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !/^\.+$/.test(id);
}

/**
 * Take the lock, or report who holds it.
 *
 * The create is exclusive, so there is no read-then-write window in which two
 * pollers can both decide the lock is free.
 */
export async function acquireLock(
  lockPath: string,
  kind: string,
): Promise<{ ok: true } | { ok: false; holder?: LockInfo }> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const info: LockInfo = { pid: process.pid, kind, startedAt: new Date().toISOString() };

  if (await createExclusive(lockPath, info)) return { ok: true };

  // Refuse whenever a live holder exists, including an unreadable lock file
  // (holder is then undefined but alive is true).
  const existing = await readLock(lockPath);
  if (!existing.ours && existing.alive) return { ok: false, holder: existing.holder };

  await unlink(lockPath).catch(() => {});
  if (await createExclusive(lockPath, info)) return { ok: true };

  // Lost the takeover race to a third poller.
  return { ok: false, holder: (await readLock(lockPath)).holder };
}

async function createExclusive(lockPath: string, info: LockInfo): Promise<boolean> {
  try {
    await writeFile(lockPath, JSON.stringify(info, null, 2), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export async function releaseLock(lockPath: string): Promise<void> {
  try {
    const holder = JSON.parse(await readFile(lockPath, "utf8")) as LockInfo;
    if (holder.pid !== process.pid) return; // someone else owns it now
    await unlink(lockPath);
  } catch {
    // Already gone.
  }
}
