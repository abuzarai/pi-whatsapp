/**
 * `/whatsapp doctor` — one-shot diagnostics.
 *
 * Everything here is read-only with respect to the platform: the token probe is a
 * zero-timeout poll, and polling does not consume the buffer, so running the
 * doctor never eats a message or advances the offset.
 *
 * It deliberately skips the network probe while the listener is running: a probe
 * would be a *newer* poll and the platform would answer the live poller with 409.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describeError, WhatsAppClient, WA_BASE } from "./client.ts";
import { personaState } from "./persona.ts";
import { formatBytes, orphanedMedia } from "./sessions.ts";
import { readLock } from "./util.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

export interface DoctorOptions {
  token?: string;
  tokenSource: "env" | "file" | "none";
  configPath: string;
  statePath: string;
  lockPath: string;
  agentCwd: string;
  piBin: string;
  tools: string;
  model: string;
  listening: boolean;
}

function execFileAsync(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, stdout: "", error: err.message });
        return;
      }
      resolve({ ok: true, stdout: String(stdout).trim() });
    });
  });
}

/** Never prints the token itself; a length is enough to confirm the right key. */
function checkToken(options: DoctorOptions): Check {
  if (!options.token) {
    return {
      name: "token",
      status: "fail",
      detail: `No API token. Set WHATSAPP_AGENT_TOKEN, or add {"token":"..."} to ${options.configPath}`,
    };
  }
  return {
    name: "token",
    status: "ok",
    detail: `Found in ${options.tokenSource === "env" ? "WHATSAPP_AGENT_TOKEN" : options.configPath} (${options.token.length} chars)`,
  };
}

async function checkApi(options: DoctorOptions): Promise<Check> {
  if (options.listening) {
    return {
      name: "api",
      status: "ok",
      detail: "Listener is running; skipped the probe so it does not replace the live poll",
    };
  }

  // A listener in ANOTHER process holds the same lock, and probing would replace
  // its in-flight poll with a 409. Its lock file is the only way to tell.
  const held = await readLock(options.lockPath);
  if (held.alive && !held.ours) {
    return {
      name: "api",
      status: "ok",
      detail: `Another process is listening (${held.holder ? `${held.holder.kind}, pid ${held.holder.pid}` : "unreadable lock"}); skipped the probe`,
    };
  }

  if (!options.token) {
    return { name: "api", status: "warn", detail: "Skipped: no token to test with" };
  }

  const client = new WhatsAppClient(options.token);
  // timeout=0 returns immediately instead of holding the connection for 25s.
  const outcome = await client.poll(undefined, undefined, 0);

  switch (outcome.kind) {
    case "empty":
      return { name: "api", status: "ok", detail: `${WA_BASE} reachable, token accepted` };
    case "updates":
      return {
        name: "api",
        status: "ok",
        detail: `${WA_BASE} reachable, token accepted (${outcome.messages.length} buffered update(s) waiting)`,
      };
    case "conflict":
      return {
        name: "api",
        status: "warn",
        detail: "Reachable, but another poll replaced ours (409). Only one poller per agent.",
      };
    case "error":
      if (outcome.status === 0) {
        return { name: "api", status: "fail", detail: `Cannot reach ${WA_BASE}: ${outcome.detail}` };
      }
      return {
        name: "api",
        status: "fail",
        detail: `HTTP ${outcome.status}${outcome.code ? ` / code ${outcome.code}` : ""}: ${describeError(outcome.status, outcome.code)}`,
      };
  }
}

async function checkLock(options: DoctorOptions): Promise<Check> {
  const { holder, alive, ours } = await readLock(options.lockPath);

  if (!holder) {
    return { name: "lock", status: "ok", detail: "Free — no other poller" };
  }
  if (ours) {
    return {
      name: "lock",
      status: "ok",
      detail: `Held by this process (pid ${holder.pid}, started ${holder.startedAt})`,
    };
  }
  if (alive) {
    return {
      name: "lock",
      status: "warn",
      detail: `Held by ${holder.kind} (pid ${holder.pid}). Only one poller may run per agent — stop it before starting here.`,
    };
  }
  return {
    name: "lock",
    status: "warn",
    detail: `Stale lock from dead pid ${holder.pid} (${holder.kind}); it will be taken over on start`,
  };
}

async function checkPi(options: DoctorOptions): Promise<Check> {
  const result = await execFileAsync(options.piBin, ["--version"], 30_000);
  if (!result.ok) {
    return { name: "pi", status: "fail", detail: `Cannot run \`${options.piBin} --version\`: ${result.error}` };
  }
  const model = options.model ? `, model ${options.model}` : "";
  return {
    name: "pi",
    status: "ok",
    detail: `${result.stdout} (tools: ${options.tools || "default"}${model})`,
  };
}

async function checkAgentCwd(options: DoctorOptions): Promise<Check> {
  const probe = path.join(options.agentCwd, ".wa-doctor-probe");
  try {
    await mkdir(options.agentCwd, { recursive: true });
    await writeFile(probe, "ok");
    await unlink(probe);
    return { name: "workspace", status: "ok", detail: `Writable: ${options.agentCwd}` };
  } catch (err) {
    return {
      name: "workspace",
      status: "fail",
      detail: `Not writable: ${options.agentCwd} (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * The child agent's persona. Missing is a warning, not a failure: `start()`
 * writes the default.
 */
async function checkPersona(options: DoctorOptions): Promise<Check> {
  const state = await personaState(options.agentCwd);

  if (state.hasOverride) {
    return {
      name: "persona",
      status: "ok",
      detail: `AGENTS.override.md takes precedence in ${options.agentCwd}`,
    };
  }
  if (state.hasAgents) {
    return { name: "persona", status: "ok", detail: `AGENTS.md present in ${options.agentCwd}` };
  }
  return {
    name: "persona",
    status: "warn",
    detail: `No AGENTS.md yet; a default persona is written to ${state.agentsMd} when the listener starts`,
  };
}

async function checkOffset(options: DoctorOptions): Promise<Check> {
  try {
    const parsed = JSON.parse(await readFile(options.statePath, "utf8")) as { next_offset?: number };
    if (typeof parsed.next_offset === "number") {
      return {
        name: "offset",
        status: "ok",
        detail: `Resuming from ${parsed.next_offset} (${options.statePath})`,
      };
    }
    return { name: "offset", status: "ok", detail: `State file has no offset; will start at the head` };
  } catch {
    return {
      name: "offset",
      status: "ok",
      detail: "First run: starts at the head, so the 30-day backlog is skipped (use offset=0 manually to replay)",
    };
  }
}

/**
 * Attachments that no longer belong to a conversation.
 *
 * Media is filed per conversation, so a mismatch between the two stores is
 * detectable.
 */
async function checkMedia(options: DoctorOptions): Promise<Check> {
  const report = await orphanedMedia(options.agentCwd);

  if (report.files === 0) {
    return { name: "media", status: "ok", detail: "Every attachment belongs to a conversation" };
  }

  const causes: string[] = [];
  if (report.looseFiles > 0) causes.push(`${report.looseFiles} loose file(s) in the inbox root`);
  if (report.conversations.length > 0) {
    causes.push(`${report.conversations.length} directory/ies with no transcript`);
  }

  return {
    name: "media",
    status: "warn",
    detail: `${report.files} attachment(s) (${formatBytes(report.bytes)}) belong to no conversation: ${causes.join(", ")}. Clear them with /whatsapp forget media`,
  };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [
    checkToken(options),
    await checkApi(options),
    await checkLock(options),
    await checkPi(options),
    await checkAgentCwd(options),
    await checkPersona(options),
    await checkOffset(options),
    await checkMedia(options),
  ];

  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

/** Render a report as the multi-line text shown by /whatsapp doctor. */
export function formatReport(report: DoctorReport): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const lines = report.checks.map((c) => `${mark[c.status]} ${c.name}: ${c.detail}`);
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;

  const summary = failed
    ? `${failed} check(s) failed`
    : warned
      ? `ready, with ${warned} warning(s)`
      : "all checks passed";
  return `${lines.join("\n")}\n— ${summary}`;
}
