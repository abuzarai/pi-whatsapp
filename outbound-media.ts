/** Local-file policy for explicitly requested outbound WhatsApp attachments. */

import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

export type OutboundMediaType = "image" | "video" | "audio" | "document" | "sticker";

export interface OutboundMediaPlan {
  type: OutboundMediaType;
  mimeType: string;
  maxBytes: number;
}

export interface MediaOptions {
  caption?: string;
  filename?: string;
}

// The manual doesn't define MB/KB multipliers; decimal caps are conservative.
const MAX_BYTES: Record<OutboundMediaType, number> = {
  image: 5_000_000,
  sticker: 500_000,
  video: 16_000_000,
  audio: 16_000_000,
  document: 16_000_000,
};

const FORMATS: Record<string, [OutboundMediaType, string]> = {
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  png: ["image", "image/png"],
  mp4: ["video", "video/mp4"],
  "3gp": ["video", "video/3gpp"],
  aac: ["audio", "audio/aac"],
  m4a: ["audio", "audio/mp4"],
  mp3: ["audio", "audio/mpeg"],
  amr: ["audio", "audio/amr"],
  ogg: ["audio", "audio/ogg"],
  opus: ["audio", "audio/opus"],
  pdf: ["document", "application/pdf"],
  txt: ["document", "text/plain"],
  doc: ["document", "application/msword"],
  docx: ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["document", "application/vnd.ms-excel"],
  xlsx: ["document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["document", "application/vnd.ms-powerpoint"],
  pptx: ["document", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  webp: ["sticker", "image/webp"],
};

/** Classification is metadata only, not codec validation or transcoding. */
export function classifyOutboundFile(filename: string, declaredMime?: string): OutboundMediaPlan {
  const extension = path.extname(filename).slice(1).toLowerCase();
  const known = Object.hasOwn(FORMATS, extension) ? FORMATS[extension] : undefined;
  const fallback = Object.values(FORMATS).find(([, mime]) => mime === declaredMime?.trim().toLowerCase());
  const [type, mimeType] = known ?? fallback ?? ["document", "application/octet-stream"];
  return { type, mimeType, maxBytes: MAX_BYTES[type] };
}

/** Shared by the tool (before upload) and the direct send API. */
export function normalizeMediaOptions(type: OutboundMediaType, opts: MediaOptions = {}): MediaOptions {
  if (!Object.hasOwn(MAX_BYTES, type)) throw new Error("Unsupported WhatsApp media type.");
  if (opts.caption !== undefined && (type === "audio" || type === "sticker")) {
    throw new Error(`Captions are not supported for ${type}.`);
  }
  if (opts.filename !== undefined) {
    if (type !== "document") throw new Error("Filename is only supported for documents.");
    if (!opts.filename.trim() || opts.filename === "." || opts.filename === ".." || /[\\/\u0000-\u001f\u007f-\u009f]/u.test(opts.filename)) {
      throw new Error("Filename must be a non-empty display name without path separators or control characters.");
    }
  }
  return {
    ...(opts.caption === undefined ? {} : { caption: Array.from(opts.caption).slice(0, 1024).join("") }),
    ...(opts.filename === undefined ? {} : { filename: opts.filename }),
  };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("File sending cancelled.", "AbortError");
}

/**
 * Read at most the cap plus one rejection byte, even if a file grows after stat.
 * The opened handle is checked again to catch replacement between stat and open.
 */
export async function readOutboundFile(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal);
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error("Path is not a regular file.");
  const tooLarge = () => new Error(`File exceeds the WhatsApp limit of ${maxBytes.toLocaleString("en-US")} bytes.`);
  if (before.size > maxBytes) throw tooLarge();

  // NONBLOCK prevents a replacement FIFO from hanging open; symlinks are allowed.
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    checkAbort(signal);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Path is not a regular file.");
    if (info.size > maxBytes) throw tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      checkAbort(signal);
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    checkAbort(signal);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
