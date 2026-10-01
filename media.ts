/**
 * Building the child-pi prompt for an inbound attachment.
 *
 * pi resolves `@path` from the working directory and consumes **everything from
 * the `@` to the end of the argument** — not just up to the next space. So
 *
 *     "@photo.jpg The user sent an image.\nSaved locally at photo.jpg"
 *
 * is read as a single filename, `photo.jpg The user sent an image.\nSaved
 * locally at photo.jpg`, and pi answers with
 *
 *     Error: File not found: <all of that>
 *
 * The whole prompt is lost. **The `@path` token must therefore be the final thing
 * in the prompt, with nothing after it.** `buildAttachmentPrompt()` guarantees
 * that; `test/pi-semantics.test.mjs` verifies it against the real pi binary.
 *
 * Only images are attached. A path pi cannot read would take the entire prompt
 * down with it, so unverified types (docx, xlsx, media containers) keep their
 * path in prose and let the agent's `read` tool try — a failure there loses the
 * attachment, not the message.
 */

/** Types pi can take by path. */
const ATTACHABLE = new Set(["image"]);

export interface AttachmentPromptInput {
  /** Inbound message type. */
  type: "image" | "audio" | "video" | "document" | "sticker" | string;
  /** Path relative to the child pi's working directory. */
  rel: string;
  caption?: string;
  filename?: string;
  /** True when the audio was recorded in the chat rather than attached. */
  voice?: boolean;
}

function describe(input: AttachmentPromptInput): string {
  switch (input.type) {
    case "image":
      return "The user sent an image.";
    case "video":
      return "The user sent a video.";
    case "document":
      return `The user sent a document (${input.filename ?? "unnamed"}).`;
    case "audio":
      return input.voice
        ? "The user sent a voice note. You cannot hear audio; say so if it needs answering."
        : "The user sent an audio file. You cannot hear audio.";
    case "sticker":
      return "The user sent a sticker.";
    default:
      return "The user sent an attachment.";
  }
}

/**
 * Build the prompt for an inbound attachment.
 *
 * When the type is attachable, the returned string ends with `@<rel>` and nothing
 * follows it. Otherwise the path appears only in prose, for the agent's `read`
 * tool, and the prompt ends with the relative path in backticks.
 */
export function buildAttachmentPrompt(input: AttachmentPromptInput): string {
  const lines = [describe(input)];
  if (input.caption) lines.push(`Caption: ${input.caption}`);

  if (ATTACHABLE.has(input.type)) {
    // The prose path is readable in the transcript; the trailing `@` is what
    // hands the file to pi.
    lines.push("", `The file is attached from \`${input.rel}\`.`);
    return `${lines.join("\n")}\n\n@${input.rel}`;
  }

  lines.push("", `Saved locally at \`${input.rel}\` — use your read tool if it helps.`);
  return lines.join("\n");
}
