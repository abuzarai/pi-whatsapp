/**
 * Locating and deleting the transcripts of WhatsApp conversations.
 *
 * Each conversation is one child-pi session, stored by pi as
 * `<project-dir>/<timestamp>_<sessionId>.jsonl` under the sessions root. Because
 * the session id is derived from the WhatsApp participant, and only the agent's
 * creator can message the agent, one agent normally has exactly one such file —
 * a single growing transcript.
 */

import { readdir, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The sessions root, resolved the same way pi resolves it:
 * `--session-dir` (CLI) > `PI_CODING_AGENT_SESSION_DIR` > the `sessionDir`
 * setting > `<agent dir>/sessions`. The CLI option is not visible to an
 * extension, so the README documents that case.
 */
export function sessionsRoot(): string {
  const env = process.env;
  if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  return path.join(agentDir, "sessions");
}

/** Transcripts belonging to one conversation, across project groups. */
export function findSessionFiles(sessionId: string, root?: string): Promise<string[]> {
  const suffix = `_${sessionId}.jsonl`;
  return scanTranscripts(root ?? sessionsRoot(), (name) => name.endsWith(suffix));
}

/** Every transcript this extension created: the child sessions are `wa-user-<id>`. */
function findAllSessionFiles(root: string = sessionsRoot()): Promise<string[]> {
  // `<timestamp>_<sessionId>.jsonl`, where sessionId starts with wa-user-
  return scanTranscripts(root, (name) => /_wa-user-.*\.jsonl$/.test(name));
}

/** Walk `<root>/<project>/<transcript>` and keep the names `match` accepts. */
async function scanTranscripts(
  root: string,
  match: (fileName: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];

  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found; // No sessions directory yet.
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) if (match(file)) found.push(path.join(dir, file));
  }

  return found;
}

export interface DeleteResult {
  /** Files actually removed. */
  files: number;
  bytes: number;
}

async function deleteFiles(paths: string[]): Promise<DeleteResult> {
  let files = 0;
  let bytes = 0;

  for (const target of paths) {
    try {
      const info = await stat(target);
      if (!info.isFile()) continue;
      await unlink(target);
      files++;
      bytes += info.size;
    } catch {
      // Already gone, or not ours to remove.
    }
  }

  return { files, bytes };
}

export function forgetConversation(
  sessionId: string,
  root?: string,
): Promise<DeleteResult> {
  return findSessionFiles(sessionId, root).then(deleteFiles);
}

export function forgetAllConversations(root?: string): Promise<DeleteResult> {
  return findAllSessionFiles(root).then(deleteFiles);
}

// ------------------------------------------------------------------- inbox
//
// Attachments live under `.wa-inbox/<sessionId>/`, one directory per
// conversation. That makes a conversation the unit of deletion, so `/whatsapp
// forget` can remove the transcript and the media it referenced together.

export interface InboxStats {
  files: number;
  bytes: number;
}

/** The `.wa-inbox` root for an agent working directory. */
export function inboxRoot(agentCwd: string): string {
  return path.join(agentCwd, ".wa-inbox");
}

/** Where one conversation's attachments live. */
export function mediaDirFor(agentCwd: string, sessionId: string): string {
  return path.join(inboxRoot(agentCwd), sessionId);
}

/** Every file under a directory, with sizes. Unreadable paths are skipped. */
async function walk(dir: string): Promise<{ path: string; size: number }[]> {
  const found: { path: string; size: number }[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (entry.isFile()) {
      try {
        found.push({ path: full, size: (await stat(full)).size });
      } catch {
        // Raced with something else; ignore.
      }
    }
  }

  return found;
}

/** Total attachments and bytes under the inbox, across every conversation. */
export async function inboxStats(inboxDir: string): Promise<InboxStats> {
  const files = await walk(inboxDir);
  return { files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

/** Remove every attachment, from every conversation. */
export async function clearInbox(inboxDir: string): Promise<InboxStats> {
  const before = await inboxStats(inboxDir);
  try {
    for (const entry of await readdir(inboxDir)) {
      await rm(path.join(inboxDir, entry), { recursive: true, force: true });
    }
  } catch {
    // Nothing to clear.
  }
  return before;
}

/** Remove one conversation's attachments, leaving every other conversation alone. */
export async function forgetConversationMedia(
  agentCwd: string,
  sessionId: string,
): Promise<InboxStats> {
  const dir = mediaDirFor(agentCwd, sessionId);
  const before = await inboxStats(dir);
  await rm(dir, { recursive: true, force: true });
  return before;
}

/** Conversation ids that currently have attachments. */
export async function mediaConversationIds(inboxDir: string): Promise<string[]> {
  try {
    const entries = await readdir(inboxDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export interface OrphanReport extends InboxStats {
  /** Session ids that have attachments but no transcript left. */
  conversations: string[];
  /** Attachments sitting outside any conversation directory. */
  looseFiles: number;
}

/**
 * Attachments that no longer belong to a conversation: files left loose in the
 * inbox root, and conversation directories whose transcript is gone.
 */
export async function orphanedMedia(
  agentCwd: string,
  root: string = sessionsRoot(),
): Promise<OrphanReport> {
  const inboxDir = inboxRoot(agentCwd);
  const conversations: string[] = [];
  let bytes = 0;
  let files = 0;
  let looseFiles = 0;

  const entries = await readdir(inboxDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (entry.isFile()) {
      looseFiles++;
      try {
        bytes += (await stat(path.join(inboxDir, entry.name))).size;
      } catch {
        // ignore
      }
      files++;
      continue;
    }

    if (!entry.isDirectory()) continue;

    const owned = await findSessionFiles(entry.name, root);
    if (owned.length > 0) continue;

    const stats = await inboxStats(path.join(inboxDir, entry.name));
    conversations.push(entry.name);
    files += stats.files;
    bytes += stats.bytes;
  }

  return { files, bytes, conversations, looseFiles };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
