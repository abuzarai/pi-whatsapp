/**
 * WhatsApp extension
 *
 * Connects pi to Meta's official WhatsApp Agent Platform
 * (https://api.whatsapp.com/agent/v1). You message your agent from WhatsApp;
 * each inbound message runs in its own child pi session, and the final answer is
 * sent back to the chat.
 *
 * Opt-in per session: start with `pi --whatsapp`, or run `/whatsapp connect`.
 * The extension never auto-starts from configuration, so a child pi cannot
 * re-enter it.
 *
 * See README.md for setup and the platform's constraints.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { WhatsAppClient, WA_BASE, type WaMessage } from "./client.ts";
import { formatReport, runDoctor } from "./doctor.ts";
import { buildAttachmentPrompt } from "./media.ts";
import { agentDir, defaultWorkspace, ensureWorkspace } from "./persona.ts";
import { runPi } from "./runner.ts";
import {
  clearInbox,
  findSessionFiles,
  forgetAllConversations,
  forgetConversation,
  forgetConversationMedia,
  formatBytes,
  inboxRoot,
  inboxStats,
  mediaConversationIds,
  mediaDirFor,
} from "./sessions.ts";
import {
  acquireLock,
  chunk,
  extFromMime,
  loadToken,
  loadTokenWithSource,
  releaseLock,
  sessionIdFor,
  sleep,
} from "./util.ts";

// All four paths follow the agent directory, so a `PI_CODING_AGENT_DIR` override
// moves the token, state, lock and workspace together.
const CONFIG_PATH = process.env.WA_CONFIG ?? path.join(agentDir(), "whatsapp-agent.json");
const STATE_PATH = process.env.WA_STATE ?? path.join(agentDir(), "whatsapp-agent-state.json");
const LOCK_PATH = process.env.WA_LOCK ?? path.join(agentDir(), "whatsapp-agent.lock");

const STATUS_KEY = "whatsapp";
const TYPING_REFRESH_MS = 20_000; // the indicator expires after 25s

// ------------------------------------------------------------------ settings

function settings() {
  return {
    piBin: process.env.WA_PI_BIN ?? "pi",
    cwd: process.env.WA_PI_CWD ?? defaultWorkspace(),
    model: process.env.WA_PI_MODEL ?? "",
    // Read-only by default: this agent is reachable from a phone.
    tools: process.env.WA_PI_TOOLS ?? "read,grep,find,ls",
    timeoutMs: Number(process.env.WA_PI_TIMEOUT_MS ?? 15 * 60 * 1000),
  };
}

// --------------------------------------------------------------------- state

/**
 * What survives between sessions: the poll offset, and the creator's participant
 * id. The id is persisted so a session that is not listening can still send —
 * outbound needs a recipient, not the poller.
 */
interface PersistedState {
  next_offset?: number;
  creator?: string;
}

async function loadState(): Promise<PersistedState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as PersistedState;
  } catch {
    return {};
  }
}

async function saveState(state: PersistedState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  // Private: this file holds a participant id, not just an offset.
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, STATE_PATH);
}

// ------------------------------------------------------------- the extension

export default function whatsappExtension(pi: ExtensionAPI) {
  let controller: AbortController | undefined;
  let running = false;
  /** Incremented by start and stop, so a superseded loop's cleanup is ignored. */
  let currentRun = 0;
  let hostCtx: ExtensionContext | undefined;

  /** Mirrors the state file. Every read refreshes it, every write re-reads first. */
  let persisted: PersistedState = {};

  /**
   * Merge a patch into the file.
   *
   * The file is re-read first. Another process — a headless service, or another
   * pi session — may have written since our last read, and merging into a stale
   * snapshot would silently drop a field this process never touched.
   */
  async function persist(patch: PersistedState): Promise<void> {
    persisted = { ...persisted, ...(await loadState()), ...patch };
    await saveState(persisted);
  }

  /**
   * The recipient, read from disk rather than from session state, so a session
   * opened before the first inbound message can still send.
   */
  async function currentCreator(): Promise<string | undefined> {
    persisted = { ...persisted, ...(await loadState()) };
    return persisted.creator;
  }

  /**
   * Send a reply in API-sized parts, paced for the platform's 12 sends/minute
   * limit. One place for chunking, pacing and counting, so the three send
   * surfaces cannot drift apart.
   */
  async function sendChunks(
    client: WhatsAppClient,
    to: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    for (const part of chunk(text)) {
      const sent = await client.sendText(to, part, signal);
      if (!sent.ok) return sent;
      stats.sent++;
      await sleep(120);
    }
    return { ok: true };
  }

  /** Conversations with a child pi currently answering, so forget cannot race one. */
  const activeRuns = new Set<string>();

  const stats = { status: "off" as "off" | "listening" | "error", detail: "", received: 0, replied: 0, sent: 0, conflicts: 0 };

  /** Conflicts above this mean a newer poller is taking the polls. */
  const CONFLICT_LIMIT = 2;

  /**
   * One state-to-text mapping, so the footer, the status command and the tool
   * cannot drift apart. `text` is undefined when off, which clears the footer.
   */
  function describeState(): { text?: string; label: string; tone: "success" | "error" } {
    if (stats.status === "listening") {
      return { text: "whatsapp: connected", label: "connected", tone: "success" };
    }

    if (stats.status === "error") {
      const short = stats.detail.length > 40 ? `${stats.detail.slice(0, 39)}…` : stats.detail;
      return {
        text: short ? `whatsapp: ${short}` : "whatsapp: error",
        label: stats.detail ? `error (${stats.detail})` : "error",
        tone: "error",
      };
    }

    return { label: "off", tone: "error" }; // off: nothing shows up
  }

  /** Last rendered footer, so identical repaints are skipped. `null` = never painted. */
  let lastPainted: string | undefined | null = null;

  function paint() {
    if (!hostCtx?.hasUI) return;
    const { text, tone } = describeState();
    const rendered = text === undefined ? undefined : hostCtx.ui.theme.fg(tone, text);

    // A retrying poller repaints the same error every few seconds; skip duplicates.
    if (rendered === lastPainted) return;
    lastPainted = rendered;

    try {
      hostCtx.ui.setStatus(STATUS_KEY, rendered);
    } catch {
      // Status is cosmetic; never let it break the poller.
    }
  }

  function setStatus(status: "off" | "listening" | "error", detail = "") {
    stats.status = status;
    // Error text can come from an HTTP response body, so it must not carry control
    // characters into the terminal or the journal.
    stats.detail = detail.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
    paint();
  }

  // ---------------------------------------------------------------- prompt

  /**
   * Save inbound media so the child agent can read it.
   *
   * Files land under `.wa-inbox/<sessionId>/`, one directory per conversation, so
   * forgetting a conversation can remove its attachments with it.
   */
  async function materialiseMedia(
    client: WhatsAppClient,
    payload: { id: string; mime_type?: string },
    signal: AbortSignal,
    sessionId: string,
  ): Promise<string> {
    const { bytes, mimeType } = await client.fetchMedia(payload.id, signal);
    const dir = mediaDirFor(settings().cwd, sessionId);
    // The id is validated before it reaches this path, and the permissions keep
    // inbound attachments private on a shared host.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const ext = extFromMime(mimeType ?? payload.mime_type ?? "") ?? "bin";
    const file = path.join(dir, `${path.basename(payload.id)}.${ext}`);
    await writeFile(file, bytes, { mode: 0o600 });
    return path.relative(settings().cwd, file);
  }

  /** Turn an inbound message into the prompt for the child pi. */
  async function promptFor(
    client: WhatsAppClient,
    msg: WaMessage,
    signal: AbortSignal,
    sessionId: string,
  ): Promise<string | undefined> {
    if (msg.type === "text") return msg.text?.body;
    if (msg.type === "reaction") return undefined; // receive-only

    const payload = msg[msg.type as "image" | "audio" | "video" | "document" | "sticker"];
    if (!payload?.id) return undefined;

    const rel = await materialiseMedia(client, payload, signal, sessionId);

    return buildAttachmentPrompt({
      type: msg.type,
      rel,
      caption: payload.caption,
      filename: payload.filename,
      voice: payload.voice,
    });
  }

  // ---------------------------------------------------------------- handling

  async function handle(client: WhatsAppClient, msg: WaMessage, signal: AbortSignal) {
    if (!msg.from.startsWith("user:")) return; // ignore anything not from a WhatsApp user

    // Persist it, so a later session that is not listening can still send here.
    if (persisted.creator !== msg.from) await persist({ creator: msg.from });
    stats.received++;
    paint();

    // Resolved before the prompt, so an attachment is filed under this conversation.
    const sessionId = sessionIdFor(msg.from);

    const prompt = await promptFor(client, msg, signal, sessionId);
    if (!prompt) return;

    void client.markRead(msg.id, signal);
    const typing = setInterval(() => void client.markRead(msg.id, signal), TYPING_REFRESH_MS);

    activeRuns.add(sessionId);
    let result;
    try {
      result = await runPi({
        prompt,
        sessionId,
        name: `wa ${msg.from}`,
        cwd: settings().cwd,
        piBin: settings().piBin,
        model: settings().model,
        tools: settings().tools,
        timeoutMs: settings().timeoutMs,
        signal,
      });
    } finally {
      clearInterval(typing);
      activeRuns.delete(sessionId);
    }

    let reply = result.text;
    if (!reply) reply = result.ok ? "(no output)" : `I hit an error running that: ${result.error ?? "unknown"}`;

    const sent = await sendChunks(client, msg.from, reply, signal);
    if (!sent.ok) {
      setStatus("error", `send failed: ${sent.error ?? "unknown"}`);
      return;
    }

    stats.replied++;
    if (stats.status === "error") setStatus("listening");
    paint();
  }

  // -------------------------------------------------------------- poll loop

  async function loop(client: WhatsAppClient, signal: AbortSignal) {
    let backoff = 1000;

    setStatus("listening");

    while (!signal.aborted) {
      // Read the offset fresh each cycle rather than caching it from session
      // start: another listener may have advanced it, and a stale value would
      // replay messages that were already answered.
      const offset = (await loadState()).next_offset;

      let outcome;
      try {
        outcome = await client.poll(offset, signal);
      } catch (err) {
        if (signal.aborted) break; // a real stop
        // A thrown poll is a failure, not a stop. Report it and retry; dying
        // quietly here is the one state the footer must never hide.
        setStatus("error", err instanceof Error ? err.message : String(err));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }

      if (outcome.kind === "empty") {
        // A 204 is a successful poll that carried nothing. Clear any transient
        // error, or a single 500 would pin the footer to "error" until the next
        // inbound message — the very thing that is not arriving.
        backoff = 1000;
        stats.conflicts = 0;
        if (stats.status === "error") setStatus("listening");
        continue;
      }

      if (outcome.kind === "conflict") {
        // Only one poller may run per agent; a second poll replaces the first.
        stats.conflicts++;
        if (stats.conflicts > CONFLICT_LIMIT) {
          setStatus("error", "another poller is running");
        }
        await sleep(2000);
        continue;
      }

      if (outcome.kind === "error") {
        setStatus("error", outcome.status ? `HTTP ${outcome.status}` : outcome.detail);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }

      backoff = 1000;
      if (stats.status === "error") setStatus("listening");
      stats.conflicts = 0;

      // Persist before replying: a crash must not replay and double-answer. A
      // missing or non-numeric next_offset leaves the previous one in place.
      if (typeof outcome.nextOffset === "number") {
        try {
          await persist({ next_offset: outcome.nextOffset });
        } catch (err) {
          // Keep polling, but say so: an unwritten offset means a replay later.
          setStatus("error", `state write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      for (const msg of outcome.messages) {
        if (signal.aborted) break;
        try {
          await handle(client, msg, signal);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          setStatus("error", detail);
          void client.sendText(msg.from, "I hit an error handling that message.", signal);
        }
      }
    }
  }

  // ------------------------------------------------------------ start / stop

  async function start(ctx: ExtensionContext, reason: string): Promise<boolean> {
    if (running) {
      ctx.ui.notify("WhatsApp is already listening", "info");
      return true;
    }

    const token = await loadToken(CONFIG_PATH);
    if (!token) {
      setStatus("error", "no API token");
      ctx.ui.notify(
        `No API token. Create one in WhatsApp under Settings > Agents > Chat info > API key, then put {"token":"..."} in ${CONFIG_PATH}`,
        "error",
      );
      return false;
    }

    const lock = await acquireLock(LOCK_PATH, "pi extension");
    if (!lock.ok) {
      setStatus("error", "another poller is running");
      const who = lock.holder ? `${lock.holder.kind}, pid ${lock.holder.pid}` : "another process";
      ctx.ui.notify(
        `Another WhatsApp poller is already running (${who}). Stop it first: only one poll is allowed per agent.`,
        "error",
      );
      return false;
    }

    hostCtx = ctx;
    // Identifies this run, so a finalizer from a superseded loop cannot clean up
    // state that belongs to a newer one.
    const run = ++currentRun;
    controller = new AbortController();
    running = true;

    // Creates <agent-dir>/whatsapp/ on first use and seeds the persona if absent.
    // Guarded: failing here after taking the lock would wedge every other session.
    try {
      const workspace = await ensureWorkspace(settings().cwd);
      if (workspace.seededPersona) {
        ctx.ui.notify(`Wrote a default persona to ${workspace.agentsMd}`, "info");
      }
    } catch (err) {
      running = false;
      controller = undefined;
      await releaseLock(LOCK_PATH);
      setStatus("error", "workspace not writable");
      ctx.ui.notify(
        `Cannot use the agent workspace at ${settings().cwd}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return false;
    }

    ctx.ui.notify(`WhatsApp listening (${reason})`, "info");

    const signal = controller.signal;
    void loop(new WhatsAppClient(token), signal)
      .catch((err) => setStatus("error", err instanceof Error ? err.message : String(err)))
      .finally(async () => {
        if (run !== currentRun) return; // a newer run owns this state now
        running = false;
        controller = undefined;
        await releaseLock(LOCK_PATH);
        // Clear the footer only on a deliberate stop. A failure has already
        // painted an error, and that must survive rather than read as "off".
        if (signal.aborted) setStatus("off");
      });

    return true;
  }

  async function stop(): Promise<void> {
    // Invalidate the loop's finalizer first: it must not release the lock that a
    // later start() acquires.
    currentRun++;
    controller?.abort();
    running = false;
    await releaseLock(LOCK_PATH);
    setStatus("off");
  }

  // ----------------------------------------------------------------- wiring

  pi.registerFlag("whatsapp", {
    description: "Start the WhatsApp agent listener for this session",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    hostCtx = ctx;
    // Each session has its own footer, so nothing carries over.
    lastPainted = null;

    // Loaded in every session, listening or not: a session that is not polling
    // can still send, and gets its recipient from here.
    persisted = await loadState();
    paint();

    // A child pi spawned to answer a WhatsApp message must not poll as well.
    if (process.env.WA_INTERNAL_CHILD === "1") return;
    if (!pi.getFlag("whatsapp")) return;

    await start(ctx, "--whatsapp");
  });

  // Idempotent: cancellation, reload, session replacement and process exit can
  // all converge here.
  pi.on("session_shutdown", async () => {
    await stop();
    if (hostCtx?.hasUI) {
      try {
        hostCtx.ui.setStatus(STATUS_KEY, undefined);
      } catch {
        // ignore
      }
    }
    lastPainted = null;
    hostCtx = undefined;
  });

  pi.registerCommand("whatsapp", {
    description: "WhatsApp: status | doctor | connect | disconnect | send <text> | forget [all|media]",
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/);

      switch (sub) {
        case "connect":
          await start(ctx, "/whatsapp connect");
          return;

        case "disconnect":
          await stop();
          ctx.ui.notify("WhatsApp stopped", "info");
          return;

        case "doctor": {
          const { token, source } = await loadTokenWithSource(CONFIG_PATH);
          const report = await runDoctor({
            token,
            tokenSource: source,
            configPath: CONFIG_PATH,
            statePath: STATE_PATH,
            lockPath: LOCK_PATH,
            agentCwd: settings().cwd,
            piBin: settings().piBin,
            tools: settings().tools,
            model: settings().model,
            listening: running,
          });
          ctx.ui.notify(formatReport(report), report.ok ? "info" : "error");
          return;
        }

        case "send": {
          const text = rest.join(" ");
          if (!text) {
            ctx.ui.notify("Usage: /whatsapp send <text>", "warning");
            return;
          }
          const token = await loadToken(CONFIG_PATH);
          if (!token) {
            ctx.ui.notify("No API token configured", "error");
            return;
          }
          const to = await currentCreator();
          if (!to) {
            ctx.ui.notify(
              "No recipient yet. Send your agent a WhatsApp message first so it learns the conversation id.",
              "warning",
            );
            return;
          }
          const sent = await sendChunks(new WhatsAppClient(token), to, text);
          ctx.ui.notify(
            sent.ok ? "Sent to WhatsApp" : `Send failed: ${sent.error}`,
            sent.ok ? "info" : "error",
          );
          paint();
          return;
        }

        case "forget": {
          const what = (rest[0] ?? "chat").toLowerCase();

          if (what === "media") {
            const cleared = await clearInbox(inboxRoot(settings().cwd));
            ctx.ui.notify(
              cleared.files
                ? `Cleared ${cleared.files} attachment(s) (${formatBytes(cleared.bytes)}) from every conversation`
                : "No attachments to clear",
              "info",
            );
            return;
          }

          if (what === "all") {
            const transcripts = await forgetAllConversations();
            // Attachments belong to conversations, so forgetting them all removes
            // the whole inbox, including anything left orphaned.
            const media = await clearInbox(inboxRoot(settings().cwd));
            const total = transcripts.files + media.files;

            ctx.ui.notify(
              total
                ? `Forgot ${transcripts.files} transcript(s) and ${media.files} attachment(s), ${formatBytes(transcripts.bytes + media.bytes)}. Every WhatsApp chat starts fresh. Your WhatsApp history is untouched.`
                : "Nothing to forget",
              "info",
            );
            return;
          }

          if (what !== "chat") {
            ctx.ui.notify("Usage: /whatsapp forget [all|media]", "warning");
            return;
          }

          const to = await currentCreator();
          if (!to) {
            ctx.ui.notify(
              "No conversation yet. Use /whatsapp forget all to clear every WhatsApp transcript.",
              "warning",
            );
            return;
          }

          const sessionId = sessionIdFor(to);
          if (activeRuns.has(sessionId)) {
            ctx.ui.notify("A reply is in flight for this conversation. Try again in a moment.", "warning");
            return;
          }

          // The transcript and the media it referenced go together.
          const media = await forgetConversationMedia(settings().cwd, sessionId);
          const transcripts = await forgetConversation(sessionId);

          const parts: string[] = [];
          if (transcripts.files) parts.push(`${transcripts.files} transcript`);
          if (media.files) parts.push(`${media.files} attachment`);
          const total = transcripts.files + media.files;

          ctx.ui.notify(
            total
              ? `Forgot this conversation: ${parts.join(" and ")}, ${formatBytes(transcripts.bytes + media.bytes)}. The next message starts fresh. Your WhatsApp history is untouched.`
              : "Nothing to forget for this conversation.",
            "info",
          );
          return;
        }

        case "status":
        default: {
          const root = inboxRoot(settings().cwd);
          const inbox = await inboxStats(root);
          const withMedia = await mediaConversationIds(root);
          const to = await currentCreator();
          const transcripts = to ? await findSessionFiles(sessionIdFor(to)) : [];
          const bits = [
            `status: ${describeState().label}`,
            `received: ${stats.received}`,
            `replied: ${stats.replied}`,
            `sent: ${stats.sent}`,
            `creator: ${to ? "known" : "not yet seen"}`,
            `transcripts: ${transcripts.length || "none"}`,
            `attachments: ${inbox.files} file(s) across ${withMedia.length} conversation(s), ${formatBytes(inbox.bytes)}`,
            `agent cwd: ${settings().cwd}`,
            `tools: ${settings().tools}`,
            `api: ${WA_BASE}`,
          ];
          ctx.ui.notify(bits.join("\n"), stats.status === "error" ? "error" : "info");
          return;
        }
      }
    },
  });

  pi.registerTool(
    defineTool({
      name: "whatsapp_send",
      label: "WhatsApp Send",
      description:
        'Send the user a WhatsApp message. Use it whenever the user asks to be messaged, pinged, texted, or notified — phrasings like "whatsapp me this", "send me a summary", or "let me know when it finishes". Compose the body yourself, and keep it concise and plain-text because it arrives as a phone notification. Only the user who created the agent is reachable.',
      promptSnippet: 'Message the user on WhatsApp ("whatsapp me …")',
      parameters: Type.Object({
        text: Type.String({ description: "Message body, up to 4096 characters" }),
        to: Type.Optional(
          Type.String({
            description:
              "Rarely needed. Defaults to the agent's creator, which is the only reachable recipient.",
          }),
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async execute(_id, params, signal) {
        const token = await loadToken(CONFIG_PATH);
        if (!token) {
          return {
            content: [{ type: "text" as const, text: `No WhatsApp API token in ${CONFIG_PATH}` }],
            details: undefined,
            isError: true,
          };
        }

        const to = params.to ?? (await currentCreator());
        if (!to) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No recipient known yet. The agent learns the conversation id after the user sends it a WhatsApp message.",
              },
            ],
            details: undefined,
            isError: true,
          };
        }

        const sent = await sendChunks(new WhatsAppClient(token), to, params.text, signal);
        if (!sent.ok) {
          return {
            content: [{ type: "text" as const, text: `WhatsApp send failed: ${sent.error}` }],
            details: { to, error: sent.error },
            isError: true,
          };
        }

        paint();
        return {
          content: [{ type: "text" as const, text: `Sent ${params.text.length} characters to WhatsApp` }],
          details: { to, characters: params.text.length },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "whatsapp_status",
      label: "WhatsApp Status",
      description:
        "Report the WhatsApp listener state: whether it is polling, how many messages it has handled, and whether a conflicting poller is running.",
      parameters: Type.Object({}),
      annotations: { readOnlyHint: true },
      async execute() {
        const known = (await currentCreator()) ? "yes" : "no";
        const summary =
          `status: ${describeState().label}\n` +
          `listening: ${running}\n` +
          `received: ${stats.received}, replied: ${stats.replied}, sent: ${stats.sent}\n` +
          `conflicts: ${stats.conflicts}\n` +
          `creator known: ${known}\n` +
          `agent cwd: ${settings().cwd}\n` +
          `agent tools: ${settings().tools}`;
        return {
          content: [{ type: "text" as const, text: summary }],
          details: {
            status: stats.status,
            listening: running,
            received: stats.received,
            replied: stats.replied,
            sent: stats.sent,
            conflicts: stats.conflicts,
            creatorKnown: known === "yes",
          },
        };
      },
    }),
  );
}
