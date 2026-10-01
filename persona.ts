/**
 * The WhatsApp agent's workspace and its default persona.
 *
 * ## Where the workspace lives
 *
 * Inside pi's own agent directory — `<agent-dir>/whatsapp/`, defaulting to
 * `~/.pi/agent/whatsapp/`.
 *
 * It sits beside the other `whatsapp-*` files in the agent directory rather than
 * inside `sessions/`, so clearing the session store to forget history does not
 * also destroy the persona and every attachment.
 *
 * The workspace is the child pi's working directory, which makes it three things
 * at once: the project group its sessions live under, the directory pi reads
 * `AGENTS.md` from, and the root of `.wa-inbox/`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** pi's agent directory, following `PI_CODING_AGENT_DIR` when set. */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
}

/** Default workspace, used when `WA_PI_CWD` is not set. */
export function defaultWorkspace(): string {
  return path.join(agentDir(), "whatsapp");
}

/**
 * Seed the agent's default persona.
 *
 * Written only when no persona is present, so a user's edits and an
 * `AGENTS.override.md` both survive untouched. pi treats `AGENTS.override.md` as
 * replacing `AGENTS.md` in the same directory.
 */
const DEFAULT_AGENTS_MD = `# WhatsApp agent

You are being reached over WhatsApp through the WhatsApp Agent Platform. Your final
assistant message is delivered back to the chat as a WhatsApp text.

## Output rules

- You are replying into a phone chat, not a terminal.
- Keep replies short by default, a few sentences unless asked for depth.
- Plain text only. No markdown tables, no headings, no code fences for one-liners.
- Never mention tool names, file paths, or internal mechanics unless asked.
- Never echo a \`user:<id>\` or \`agent:<id>\` identifier back to the user.
- If a task needs a long answer, give the result and offer to expand.
- If you cannot do something, say so in one sentence.

## Attachments

- Incoming attachments are saved under \`.wa-inbox/<conversation>/\` in your working
  directory. Images are attached to the prompt directly, so you can see them.
- Documents, audio and video are not attached — read the file if a path is given.
- You cannot hear audio. Say so plainly rather than guessing at a voice note.

## Working rules

- This folder is your working directory. Anything you write here persists between
  messages, so treat it as scratch space.
- Prefer doing the work over describing how to do it.
- If a request is ambiguous, ask one short clarifying question instead of guessing.
`;

export interface WorkspaceState {
  agentsMd: string;
  /** True when this call created the default persona. */
  seededPersona: boolean;
  /** True when AGENTS.override.md exists and takes precedence. */
  hasOverride: boolean;
}

async function isFile(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

export interface PersonaState {
  agentsMd: string;
  hasAgents: boolean;
  hasOverride: boolean;
}

/** Which persona files exist in a workspace. Read-only. */
export async function personaState(cwd: string): Promise<PersonaState> {
  const agentsMd = path.join(cwd, "AGENTS.md");
  return {
    agentsMd,
    hasAgents: await isFile(agentsMd),
    hasOverride: await isFile(path.join(cwd, "AGENTS.override.md")),
  };
}

/**
 * Create the workspace if needed and seed the persona when absent.
 * Idempotent, and never overwrites anything.
 */
export async function ensureWorkspace(cwd: string): Promise<WorkspaceState> {
  await mkdir(cwd, { recursive: true });

  const state = await personaState(cwd);
  let seededPersona = false;
  // Seeding is pointless when an override exists, since it replaces AGENTS.md.
  if (!state.hasOverride && !state.hasAgents) {
    await writeFile(state.agentsMd, DEFAULT_AGENTS_MD);
    seededPersona = true;
  }

  return {
    agentsMd: state.agentsMd,
    seededPersona,
    hasOverride: state.hasOverride,
  };
}
