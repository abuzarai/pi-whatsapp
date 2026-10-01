/**
 * Tests that assert pi's own command-line semantics rather than our orchestration.
 *
 * These spawn the REAL pi binary with a REAL model call, because `@path` argument
 * parsing is not observable through a stub: a stub `pi` accepts any argv, so
 * orchestration tests cannot catch a malformed attachment prompt.
 *
 * Run: node --test test/pi-semantics.test.mjs
 * Skips itself (with a reason) when no model is authenticated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";

import { findJiti, findPiBin } from "./resolve.mjs";

const require = createRequire(import.meta.url);

const PI_BIN = findPiBin();
const EXT_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { createJiti } = require(findJiti());
const jiti = createJiti(path.join(EXT_DIR, "media.ts"));
const { buildAttachmentPrompt } = jiti(path.join(EXT_DIR, "media.ts"));

/** Minimal solid-colour PNG, so the expected answer is unambiguous. */
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }

  const crc32 = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Run pi in print mode.
 *
 * stdin must be closed (`ignore`, i.e. /dev/null): pi prepends piped stdin to the
 * prompt, so an open-but-empty pipe makes it wait for EOF forever. `execFile` leaves
 * stdin as an open pipe, which is why this uses `spawn` — the same reason
 * runner.ts uses `stdio: ["ignore", ...]`.
 */
function runPi(args, cwd, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const child = spawn(PI_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** One tiny call to see whether a model is actually reachable. */
async function modelReady(cwd) {
  const result = await runPi(["--print", "--no-tools", "--", "Reply with exactly: OK"], cwd, 120_000);
  return result.code === 0 && /ok/i.test(result.stdout);
}

const workdir = await mkdtemp(path.join(tmpdir(), "wa-semantics-"));
await writeFile(path.join(workdir, "red.png"), solidPng(32, 32, [255, 0, 0]));

const ready = await modelReady(workdir);
const skip = ready ? false : "no authenticated model available";
if (!ready) console.error("[pi-semantics] skipping: no authenticated model available");

test("pi semantics: @path consumes to the end of the argument", { skip }, async () => {
  // This is the behaviour the extension's prompt builder works around. If it ever
  // changes, the invariant in media.ts can be relaxed.
  const broken = "@red.png The user sent an image.\nSaved locally at red.png";
  const result = await runPi(
    ["--print", "--session-id", "sem-broken", "--tools", "read", "--", broken],
    workdir,
  );

  const output = result.stdout + result.stderr;
  assert.match(output, /File not found/, "text after @path is absorbed into the filename");
});

test("pi semantics: the prompt the extension builds is actually seen", { skip }, async () => {
  const prompt = buildAttachmentPrompt({ type: "image", rel: "red.png", caption: "look" });

  const result = await runPi(
    ["--print", "--session-id", "sem-image", "--tools", "read", "--", prompt],
    workdir,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.ok(!/File not found/.test(result.stdout), "the image must resolve");
  assert.match(result.stdout, /red/i, "the model must describe the attached image");
});

test("pi semantics: a caption containing @ still resolves the attachment", { skip }, async () => {
  const prompt = buildAttachmentPrompt({
    type: "image",
    rel: "red.png",
    caption: "ping me @example.com about this",
  });

  const result = await runPi(
    ["--print", "--session-id", "sem-atcaption", "--tools", "read", "--", prompt],
    workdir,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.ok(!/File not found/.test(result.stdout), "an earlier @ must not steal the path");
  assert.match(result.stdout, /red/i);
});

test("pi semantics: a non-attachable type names the path without an @ token", { skip }, async () => {
  const prompt = buildAttachmentPrompt({
    type: "document",
    rel: "red.png",
    filename: "report.pdf",
  });

  assert.ok(!prompt.includes("@"), "documents are not attached by path");

  const result = await runPi(
    ["--print", "--session-id", "sem-doc", "--tools", "read", "--", prompt],
    workdir,
  );

  assert.equal(result.code, 0, result.stderr);
  // The read tool should still reach the file named in prose.
  assert.match(result.stdout, /red/i);
});

test.after(async () => {
  await rm(workdir, { recursive: true, force: true });
  // pi groups sessions by working directory, escaping `/` as `-`.
  const projectDir = `-${workdir.replace(/\//g, "-")}--`;
  await rm(path.join(homedir(), ".pi/agent/sessions", projectDir), {
    recursive: true,
    force: true,
  });
});
