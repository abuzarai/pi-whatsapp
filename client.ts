/**
 * WhatsApp Agent Platform API client.
 *
 * Request shapes and error codes follow
 * https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf
 */

import { isSafeMediaId, sleep } from "./util.ts";

export const WA_BASE = process.env.WA_BASE_URL ?? "https://api.whatsapp.com/agent/v1";

/** 25 is the documented maximum for the long-poll timeout. */
const POLL_TIMEOUT_S = 25;

/**
 * Hosts the platform serves media bytes from.
 *
 * The download URL is supplied by the API response, so it is checked before the
 * bearer token is attached to it.
 */
const MEDIA_HOSTS = ["lookaside.fbsbx.com", "fbcdn.net"];

function isAllowedMediaUrl(url: URL): boolean {
  let base: URL;
  try {
    base = new URL(WA_BASE);
  } catch {
    return false;
  }

  if (url.origin === base.origin) return true;
  if (url.protocol !== "https:") return false;
  if (url.port !== "" && url.port !== "443") return false;
  return MEDIA_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export interface WaMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
  animated?: boolean;
}

export interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WaMedia;
  audio?: WaMedia;
  video?: WaMedia;
  document?: WaMedia;
  sticker?: WaMedia;
  reaction?: { message_id: string; emoji: string };
  context?: { id: string; from: string };
}

export type PollOutcome =
  | { kind: "empty" }
  | { kind: "conflict" }
  /** `nextOffset` is absent when the platform sends none, so the old offset stands. */
  | { kind: "updates"; nextOffset?: number; messages: WaMessage[] }
  | { kind: "error"; status: number; detail: string; code?: number };

/**
 * The platform reports failures as `{error:{code,message}}`. The numeric code is
 * what distinguishes "no token" from "bad token".
 */
function parseApiError(status: number, body: string): { status: number; code?: number; detail: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: number; message?: string } };
    if (parsed.error) {
      return {
        status,
        code: typeof parsed.error.code === "number" ? parsed.error.code : undefined,
        detail: parsed.error.message ?? body.slice(0, 300),
      };
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return { status, detail: body.slice(0, 300) };
}

/** Turn an HTTP status plus platform error code into something actionable. */
export function describeError(status: number, code?: number): string {
  if (status === 0) return "No HTTP response — network or DNS failure.";
  if (code === 190 || status === 401) {
    return "The Authorization header was missing or malformed. Send it as `Authorization: Bearer <token>`.";
  }
  if (code === 100) {
    return "The token is present but invalid. Regenerate it in WhatsApp under Settings > Agents > Chat info > API key.";
  }
  if (code === 131005 || status === 403) {
    return "The recipient is not the agent's creator. Only you can chat with your own agent.";
  }
  if (code === 131009) return "A required field is missing or malformed.";
  if (code === 131016 || status === 503) return "Not accepted for delivery; send again after backing off.";
  if (code === 131053) return "Media rejected: over the size limit, or an unsupported MIME type.";
  if (code === 130429 || status === 429) return "Rate limited. Back off and retry.";
  if (status === 409) return "Another poll replaced this one. Only one poll may run per agent.";
  if (status >= 500) return "Server error. Retry with exponential backoff.";
  return "Unexpected response.";
}

export class WhatsAppClient {
  constructor(private readonly token: string) {}

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Fetch with the API token, bounded by both a deadline and the caller's signal. */
  private request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<Response> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = outer ? AbortSignal.any([outer, deadline]) : deadline;
    return fetch(url, { ...init, signal, headers: { ...this.auth(), ...(init.headers ?? {}) } });
  }

  /**
   * Long-poll for inbound messages and receipts.
   *
   * `timeoutS` defaults to the 25s maximum. Pass 0 for an immediate probe, which
   * is what the doctor command uses: polling does not consume the buffer, and an
   * offset-less request starts at the head, so a probe changes no state.
   */
  async poll(
    offset: number | undefined,
    signal?: AbortSignal,
    timeoutS: number = POLL_TIMEOUT_S,
  ): Promise<PollOutcome> {
    const qs = new URLSearchParams({ limit: "50", timeout: String(timeoutS) });
    if (offset !== undefined) qs.set("offset", String(offset));

    let res: Response;
    try {
      res = await this.request(`${WA_BASE}/updates?${qs}`, {}, (timeoutS + 15) * 1000, signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err; // caller stopped us
      return { kind: "error", status: 0, detail: err instanceof Error ? err.message : String(err) };
    }

    // 204: the timeout elapsed with nothing to deliver. Re-poll with the same offset.
    if (res.status === 204) return { kind: "empty" };
    // 409: a newer poll replaced this one. Only one poll may run per agent.
    if (res.status === 409) return { kind: "conflict" };

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { kind: "error", ...parseApiError(res.status, body) };
    }

    let body: {
      next_offset?: unknown;
      entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[];
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // A 200 with an unreadable body must be a reported failure, not a silent stop.
      return { kind: "error", status: 0, detail: "updates response was not valid JSON" };
    }

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages ?? [];
    const next = Number(body.next_offset);
    return { kind: "updates", nextOffset: Number.isFinite(next) ? next : undefined, messages };
  }

  /** Mark an inbound message read and show a typing indicator. */
  async markRead(messageId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.request(
        `${WA_BASE}/statuses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            status: "read",
            message_id: messageId,
            typing_indicator: { type: "text" },
          }),
        },
        20_000,
        signal,
      );
    } catch {
      // Best-effort: a missing receipt must not break the reply.
    }
  }

  /**
   * Send one text message, retrying only the documented transient failures.
   * A 4xx other than 429 is permanent (403/131005 means the recipient is not the
   * agent's creator), so it fails fast.
   */
  async sendText(
    to: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    let lastError = "unknown error";

    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await this.request(
          `${WA_BASE}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to,
              type: "text",
              text: { body },
            }),
          },
          30_000,
          signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return { ok: false, error: "aborted" };
        lastError = err instanceof Error ? err.message : String(err);
        await sleep(1500 * 2 ** attempt);
        continue;
      }

      if (res.ok) return { ok: true };

      const parsed = parseApiError(res.status, await res.text().catch(() => ""));
      lastError = `${res.status}: ${parsed.detail}`;
      // 131016 (not accepted for delivery) is retryable even when the status is
      // not 5xx, as the manual documents.
      const retryable = res.status === 429 || res.status >= 500 || parsed.code === 131016;
      if (!retryable) return { ok: false, error: lastError };
      if (attempt < 3) await sleep(1500 * 2 ** attempt);
    }

    return { ok: false, error: lastError };
  }

  /**
   * Download the bytes of an inbound media object.
   *
   * The id and the download URL both come from the API response, so both are
   * validated before use: the id reaches a filesystem path, and the URL receives
   * the bearer token.
   */
  async fetchMedia(
    mediaId: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; mimeType?: string }> {
    if (!isSafeMediaId(mediaId)) throw new Error("invalid media id");

    const metaRes = await this.request(
      `${WA_BASE}/media/${encodeURIComponent(mediaId)}`,
      {},
      30_000,
      signal,
    );
    if (!metaRes.ok) throw new Error(`media metadata failed: ${metaRes.status}`);
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };

    // Parsed once: the check and the error message both need the URL object, and
    // `new URL` on unvalidated input is what made the rejection path throw.
    let mediaUrl: URL;
    try {
      mediaUrl = new URL(meta.url ?? "");
    } catch {
      throw new Error("media download url is missing or malformed");
    }
    if (!isAllowedMediaUrl(mediaUrl)) {
      throw new Error(`media download host not allowed: ${mediaUrl.hostname}`);
    }

    const binRes = await this.request(mediaUrl.href, {}, 120_000, signal);
    if (!binRes.ok) throw new Error(`media download failed: ${binRes.status}`);

    return { bytes: Buffer.from(await binRes.arrayBuffer()), mimeType: meta.mime_type };
  }
}
