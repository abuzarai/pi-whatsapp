/**
 * Runs one child `pi --print` per inbound WhatsApp message.
 *
 * The child gets its own session (`--session-id`), so each WhatsApp conversation
 * keeps continuous context while staying out of the pi session that hosts the
 * extension.
 */

import { spawn } from "node:child_process";

/**
 * Session metadata that pi injects into shell tools. A child pi must not inherit
 * these, or it would appear to belong to the parent's session.
 */
const SESSION_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

/**
 * Credentials the child has no use for. It is the phone-reachable side of this
 * extension, so it should not carry the API token in its environment.
 */
const SECRET_ENV_KEYS = ["WHATSAPP_AGENT_TOKEN"];

export interface PiRunOptions {
  prompt: string;
  sessionId: string;
  name: string;
  cwd: string;
  piBin?: string;
  model?: string;
  tools?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PiRunResult {
  ok: boolean;
  text: string;
  error?: string;
}

export function runPi(options: PiRunOptions): Promise<PiRunResult> {
  const { prompt, sessionId, name, cwd, timeoutMs, signal } = options;

  return new Promise<PiRunResult>((resolve) => {
    const args = ["--print", "--session-id", sessionId, "-n", name];
    if (options.model) args.push("--model", options.model);
    if (options.tools) args.push("--tools", options.tools);
    args.push("--", prompt); // `--` lets a prompt start with "-"

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [...SESSION_ENV_KEYS, ...SECRET_ENV_KEYS]) delete env[key];
    // A child pi must not poll as well.
    env.WA_INTERNAL_CHILD = "1";

    let child;
    try {
      child = spawn(options.piBin ?? "pi", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve({ ok: false, text: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: PiRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, text: stdout.trim(), error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ ok: false, text: stdout.trim(), error: "aborted" });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => finish({ ok: false, text: "", error: err.message }));

    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, text: stdout.trim() });
      else finish({ ok: false, text: stdout.trim(), error: stderr.trim().slice(-500) || `exit ${code}` });
    });
  });
}
