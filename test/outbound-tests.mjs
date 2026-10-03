/** Registered by whatsapp.test.mjs; all sends use fake tokens and loopback APIs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import timers from "node:timers/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { findPiPackage } from "./resolve.mjs";

export function registerOutboundTests({ createJiti, EXT_DIR, startMockServer, fixture, startPi, stopPi, waitFor }) {
  function load(name, options = {}) {
    return createJiti(path.join(EXT_DIR, name), { moduleCache: false, ...options })(path.join(EXT_DIR, name));
  }
  function env(t, values) {
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  async function api(t, options = {}) {
    const mock = await startMockServer({ messages: [], ...options });
    t.after(() => { mock.server.closeAllConnections(); mock.server.close(); });
    env(t, { WA_BASE_URL: `http://127.0.0.1:${mock.port}/agent/v1` });
    return { ...mock, ...load("client.ts") };
  }
  function fastTextDelays(t) {
    const realTimeout = globalThis.setTimeout;
    const delays = [];
    t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
      delays.push(ms);
      return realTimeout(fn, 0, ...args);
    });
    return delays;
  }
  async function toolFixture(t, options = {}) {
    const f = await fixture([], options);
    t.after(async () => { f.mock.server.closeAllConnections(); f.mock.server.close(); await rm(f.dir, { recursive: true, force: true }); });
    await writeFile(f.statePath, JSON.stringify({ creator: "user:1" }));
    const entry = findPiPackage("@earendil-works/pi-coding-agent");
    const typebox = findPiPackage("typebox");
    env(t, { ...f.env, WHATSAPP_AGENT_TOKEN: "", WA_INTERNAL_CHILD: "1", PI_CODING_AGENT_DIR: f.dir });
    // The actual TypeBox and defineTool, without importing the unrelated SDK runtime.
    const extension = await createJiti(path.join(EXT_DIR, "index.ts"), {
      moduleCache: false,
      alias: {
        "@earendil-works/pi-ai": typebox,
        "@earendil-works/pi-coding-agent": path.join(path.dirname(entry), "core/extensions/types.js"),
      },
    }).import(path.join(EXT_DIR, "index.ts"), { default: true });
    const tools = new Map();
    extension({ registerTool(tool) { tools.set(tool.name, tool); }, registerFlag() {}, registerCommand() {}, on() {} });
    const cwd = path.join(f.dir, "terminal");
    await mkdir(cwd);
    const execute = (args, signal) => tools.get("whatsapp_send_file").execute("test-call", args, signal, undefined, { cwd, hasUI: false });
    const sentCount = async () => (await tools.get("whatsapp_status").execute()).details.sent;
    return { ...f, cwd, tools, execute, sentCount };
  }

  test("client: characterize text retry results, delays and cancellation", async (t) => {
    const { WhatsAppClient } = load("client.ts");
    const delays = fastTextDelays(t);
    const cases = [
      { responses: [new Response(null, { status: 200 })], result: { ok: true }, delays: [] },
      { responses: [new Response('{"error":{"code":131005,"message":"not creator"}}', { status: 403 })], result: { ok: false, error: "403: not creator" }, delays: [] },
      { responses: Array.from({ length: 4 }, () => new Response("limited", { status: 429 })), result: { ok: false, error: "429: limited" }, delays: [1500, 3000, 6000] },
      { responses: Array.from({ length: 4 }, () => new Error("network down")), result: { ok: false, error: "network down" }, delays: [1500, 3000, 6000, 12000] },
      { responses: [new DOMException("cancelled", "AbortError")], result: { ok: false, error: "aborted" }, delays: [] },
      { responses: [new Response('{"error":{"code":131016,"message":"busy"}}', { status: 400 }), new Response(null, { status: 200 })], result: { ok: true }, delays: [1500] },
      { responses: [new DOMException("timeout", "TimeoutError"), new Response(null, { status: 200 })], result: { ok: true }, delays: [1500] },
    ];
    for (const c of cases) {
      delays.length = 0;
      const client = new WhatsAppClient("fake");
      let attempts = 0;
      t.mock.method(client, "request", async (_url, init) => {
        assert.equal(JSON.parse(init.body).text.body, "hello");
        const response = c.responses[attempts++];
        if (response instanceof Error) throw response;
        return response;
      });
      assert.deepEqual(await client.sendText("user:1", "hello"), c.result);
      assert.equal(attempts, c.responses.length);
      assert.deepEqual(delays, c.delays);
    }
  });

  test("outbound: all known formats, case, MIME fallback and exact caps", () => {
    const { classifyOutboundFile: classify } = load("outbound-media.ts");
    const formats = [
      ["jpg", "image", "image/jpeg"], ["jpeg", "image", "image/jpeg"], ["png", "image", "image/png"],
      ["mp4", "video", "video/mp4"], ["3gp", "video", "video/3gpp"],
      ["aac", "audio", "audio/aac"], ["m4a", "audio", "audio/mp4"], ["mp3", "audio", "audio/mpeg"],
      ["amr", "audio", "audio/amr"], ["ogg", "audio", "audio/ogg"], ["opus", "audio", "audio/opus"],
      ["pdf", "document", "application/pdf"], ["txt", "document", "text/plain"], ["doc", "document", "application/msword"],
      ["docx", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["xls", "document", "application/vnd.ms-excel"], ["xlsx", "document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["ppt", "document", "application/vnd.ms-powerpoint"], ["pptx", "document", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["webp", "sticker", "image/webp"],
    ];
    for (const [ext, type, mimeType] of formats) {
      assert.deepEqual(classify(`FILE.${ext.toUpperCase()}`), { type, mimeType, maxBytes: type === "image" ? 5_000_000 : type === "sticker" ? 500_000 : 16_000_000 });
    }
    assert.equal(classify("a.png", "application/pdf").mimeType, "image/png");
    assert.equal(classify("a.unknown", " Application/PDF ").mimeType, "application/pdf");
    for (const filename of ["file", "a.zip", "a.exe", "a.svg", "a.constructor", "a.__proto__"]) {
      assert.equal(classify(filename, "fake/mime").mimeType, "application/octet-stream");
    }
  });

  test("outbound: caption and filename policy preserves Unicode and content", () => {
    const { normalizeMediaOptions: normalize } = load("outbound-media.ts");
    for (const type of ["audio", "sticker"]) assert.throws(() => normalize(type, { caption: "" }), /Captions/);
    for (const type of ["image", "video", "audio", "sticker"]) assert.throws(() => normalize(type, { filename: "a.pdf" }), /only supported/);
    for (const filename of ["", "  ", ".", "..", "../a", "a/b", "a\\b", "a\n.pdf", "a\u0000.pdf", "a\u0085.pdf"]) {
      assert.throws(() => normalize("document", { filename }), /display name/);
    }
    assert.deepEqual(normalize("image"), {});
    assert.deepEqual(normalize("document", { caption: " keep spaces ", filename: "résumé.pdf" }), { caption: " keep spaces ", filename: "résumé.pdf" });
    const capped = normalize("image", { caption: "😀".repeat(1025) }).caption;
    assert.equal(Array.from(capped).length, 1024);
    assert.equal(capped, "😀".repeat(1024));
  });

  test("outbound: bounded reads, exact byte boundary, symlinks and special files", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "wa-file-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { readOutboundFile: read } = load("outbound-media.ts");
    const file = path.join(dir, "file");
    await writeFile(file, Buffer.from([0, 128, 255, 0]));
    assert.deepEqual(await read(file, 4), Buffer.from([0, 128, 255, 0]));
    await assert.rejects(read(file, 3), /limit of 3 bytes/);
    await assert.rejects(read(dir, 10), /regular file/);
    await assert.rejects(read(path.join(dir, "absent"), 10), { code: "ENOENT" });
    await assert.rejects(read(file, 10, AbortSignal.abort()), { name: "AbortError" });
    if (process.platform !== "win32") {
      await symlink(file, path.join(dir, "link"));
      assert.deepEqual(await read(path.join(dir, "link"), 4), await readFile(file));
      const fifo = path.join(dir, "fifo");
      execFileSync("mkfifo", [fifo]);
      await assert.rejects(read(fifo, 10), /regular file/);
    }
  });

  test("outbound: growing files remain bounded and handles close after rejection", async (t) => {
    const { readOutboundFile: read } = load("outbound-media.ts");
    const meta = { size: 0, isFile: () => true };
    let closed = false;
    let requested = 0;
    t.mock.method(fs, "stat", async () => meta);
    t.mock.method(fs, "open", async () => ({
      stat: async () => meta,
      read: async (buffer, _offset, length) => { requested += length; buffer.fill(1); return { bytesRead: length }; },
      close: async () => { closed = true; },
    }));
    await assert.rejects(read("growing", 10), /limit of 10 bytes/);
    assert.equal(requested, 11);
    assert.equal(closed, true);
  });

  test("client: upload sends valid multipart boundary, MIME and exact binary bytes", async (t) => {
    const a = await api(t);
    const bytes = Buffer.from([0, 255, 128, 1, 13, 10, 0]);
    assert.deepEqual(await new a.WhatsAppClient("fake").uploadMedia(bytes, "application/pdf"), { id: "media-upload-1" });
    const { headers, body } = a.received.uploads[0];
    assert.equal(headers.authorization, "Bearer fake");
    assert.match(headers["content-type"], /^multipart\/form-data; boundary=/);
    const boundary = headers["content-type"].split("boundary=")[1];
    assert.ok(body.includes(Buffer.from(`--${boundary}\r\n`)));
    assert.ok(body.includes(Buffer.from('name="messaging_product"\r\n\r\nwhatsapp\r\n')));
    assert.ok(body.includes(Buffer.from('name="type"\r\n\r\napplication/pdf\r\n')));
    const marker = Buffer.from('name="file"; filename="file"\r\nContent-Type: application/pdf\r\n\r\n');
    const start = body.indexOf(marker) + marker.length;
    assert.ok(start >= marker.length);
    assert.deepEqual(body.subarray(start, start + bytes.length), bytes);
    assert.match(body.subarray(start + bytes.length).toString(), new RegExp(`^\\r\\n--${boundary}--`));
  });

  test("client: upload retries transient failures, retains codes and rejects bad IDs", async (t) => {
    const delays = [];
    t.mock.method(timers, "setTimeout", async (ms) => { delays.push(ms); });
    const { WhatsAppClient, MediaApiError } = load("client.ts");
    for (const [status, code] of [[429, 130429], [500, 2], [400, 131016]]) {
      let attempts = 0;
      const client = new WhatsAppClient("fake");
      t.mock.method(client, "request", async () => ++attempts === 1 ? new Response(JSON.stringify({ error: { code } }), { status }) : Response.json({ id: "m1" }));
      assert.deepEqual(await client.uploadMedia(Buffer.from("abc"), "image/png"), { id: "m1" });
      assert.equal(attempts, 2);
    }
    for (const [status, code] of [[403, 131005], [400, 131053], [400, 100], [401, 190]]) {
      let attempts = 0;
      const client = new WhatsAppClient("fake");
      t.mock.method(client, "request", async () => { attempts++; return Response.json({ error: { code, message: "untrusted\u001b[2J" } }, { status }); });
      await assert.rejects(client.uploadMedia(Buffer.from("abc"), "image/png"), (err) => err instanceof MediaApiError && err.status === status && err.code === code && !err.message.includes("untrusted"));
      assert.equal(attempts, 1);
    }
    for (const body of [{}, { id: "" }, { id: " " }, { id: 42 }, null, "not json"]) {
      const client = new WhatsAppClient("fake");
      let attempts = 0;
      t.mock.method(client, "request", async () => { attempts++; return typeof body === "string" ? new Response(body) : Response.json(body); });
      await assert.rejects(client.uploadMedia(Buffer.from("abc"), "image/png"), /Upload response/);
      assert.equal(attempts, 1);
    }
    let attempts = 0;
    const client = new WhatsAppClient("fake");
    t.mock.method(client, "request", async () => { attempts++; throw new Error("network"); });
    delays.length = 0;
    await assert.rejects(client.uploadMedia(Buffer.from("abc"), "image/png"), /network or DNS/);
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [1500, 3000, 6000]);
  });

  test("client: upload abort interrupts retry wait and caller abort differs from timeout", async (t) => {
    const { WhatsAppClient } = load("client.ts");
    const client = new WhatsAppClient("fake");
    let calls = 0;
    t.mock.method(client, "request", async () => { calls++; return new Response(null, { status: 429 }); });
    await assert.rejects(client.uploadMedia(Buffer.from("abc"), "image/png", AbortSignal.abort("custom")), { name: "AbortError" });
    assert.equal(calls, 0);
    const abort = new AbortController();
    const pending = client.uploadMedia(Buffer.from("abc"), "image/png", abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort("custom");
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(calls, 1);
    const delays = [];
    t.mock.method(timers, "setTimeout", async (ms) => { delays.push(ms); });
    calls = 0;
    const timedClient = new (load("client.ts").WhatsAppClient)("fake");
    t.mock.method(timedClient, "request", async () => {
      if (++calls === 1) throw new DOMException("deadline", "TimeoutError");
      return Response.json({ id: "m1" });
    });
    assert.deepEqual(await timedClient.uploadMedia(Buffer.from("abc"), "image/png"), { id: "m1" });
    assert.deepEqual(delays, [1500]);
  });

  test("client: upload retries interrupted success bodies but fails fast on invalid JSON", async (t) => {
    t.mock.method(timers, "setTimeout", async () => {});
    const { WhatsAppClient } = load("client.ts");
    const client = new WhatsAppClient("fake");
    let calls = 0;
    const interrupted = new Response(null, { status: 200 });
    interrupted.json = async () => { throw new DOMException("body deadline", "TimeoutError"); };
    t.mock.method(client, "request", async () => ++calls === 1 ? interrupted : Response.json({ id: "m1" }));
    assert.deepEqual(await client.uploadMedia(Buffer.from("abc"), "image/png"), { id: "m1" });
    assert.equal(calls, 2);
    calls = 0;
    t.mock.method(client, "request", async () => { calls++; return new Response("not-json"); });
    await assert.rejects(client.uploadMedia(Buffer.from("abc"), "image/png"), /not valid JSON/);
    assert.equal(calls, 1);
  });

  test("client: upload retries interrupted error bodies with bounded backoff", async (t) => {
    const delays = [];
    t.mock.method(timers, "setTimeout", async (ms) => { delays.push(ms); });
    const { WhatsAppClient, MediaApiError } = load("client.ts");
    const interrupted = (failure) => {
      const response = Response.json({ error: { code: 131016 } }, { status: 400 });
      response.text = async () => { throw failure; };
      return response;
    };
    for (const failure of [new DOMException("body deadline", "TimeoutError"), new TypeError("connection terminated")]) {
      delays.length = 0;
      const client = new WhatsAppClient("fake");
      let calls = 0;
      t.mock.method(client, "request", async () => ++calls === 1 ? interrupted(failure) : Response.json({ id: "m1" }));
      assert.deepEqual(await client.uploadMedia(Buffer.from("abc"), "image/png"), { id: "m1" });
      assert.equal(calls, 2);
      assert.deepEqual(delays, [1500]);
    }
    const exhausted = new WhatsAppClient("fake");
    let calls = 0;
    delays.length = 0;
    t.mock.method(exhausted, "request", async () => { calls++; return interrupted(new TypeError("connection terminated")); });
    await assert.rejects(exhausted.uploadMedia(Buffer.from("abc"), "image/png"), (err) => err instanceof MediaApiError && err.status === 400 && /response body could not be read/.test(err.message));
    assert.equal(calls, 4);
    assert.deepEqual(delays, [1500, 3000, 6000]);
  });

  test("client: caller cancellation during upload error-body read never retries", async (t) => {
    const delays = [];
    t.mock.method(timers, "setTimeout", async (ms) => { delays.push(ms); });
    const { WhatsAppClient } = load("client.ts");
    const client = new WhatsAppClient("fake");
    const controller = new AbortController();
    let calls = 0;
    t.mock.method(client, "request", async () => {
      calls++;
      const response = new Response(null, { status: 400 });
      response.text = async () => { controller.abort("custom"); throw new DOMException("cancelled", "AbortError"); };
      return response;
    });
    await assert.rejects(client.uploadMedia(Buffer.from("abc"), "image/png", controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });

  test("client: sendMedia payloads, local validation, retry ID reuse and safe errors", async (t) => {
    const { WhatsAppClient } = load("client.ts");
    const client = new WhatsAppClient("fake");
    const payloads = [];
    t.mock.method(client, "request", async (_url, init) => { payloads.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); });
    for (const type of ["image", "video", "audio", "document", "sticker"]) {
      const opts = type === "audio" || type === "sticker" ? {} : { caption: "caption", ...(type === "document" ? { filename: "name.pdf" } : {}) };
      assert.deepEqual(await client.sendMedia("user:1", type, "m1", opts), { ok: true });
      assert.deepEqual(payloads.at(-1), { messaging_product: "whatsapp", to: "user:1", type, [type]: { id: "m1", ...opts } });
    }
    assert.equal((await client.sendMedia("user:1", "audio", "m1", { caption: "no" })).ok, false);
    assert.equal((await client.sendMedia("user:1", "image", "m1", { filename: "no" })).ok, false);
    assert.equal((await client.sendMedia("user:1", "image", "")).ok, false);
    assert.equal(payloads.length, 5);
    const delays = fastTextDelays(t);
    let calls = 0;
    t.mock.method(client, "request", async (_url, init) => {
      assert.equal(JSON.parse(init.body).document.id, "same-id");
      return ++calls === 1 ? Response.json({ error: { code: 131016 } }, { status: 400 }) : new Response(null, { status: 200 });
    });
    assert.deepEqual(await client.sendMedia("user:1", "document", "same-id"), { ok: true });
    assert.deepEqual(delays, [1500]);
    t.mock.method(client, "request", async () => Response.json({ error: { code: 131009, message: "EVIL\u001b[2J" } }, { status: 400 }));
    assert.match((await client.sendMedia("user:1", "image", "m1")).error, /unknown or expired/);
    t.mock.method(client, "request", async () => Response.json({ error: { code: 100 } }, { status: 400 }));
    assert.match((await client.sendMedia("user:1", "image", "m1")).error, /token, media ID and caption/);
    assert.deepEqual(await client.sendMedia("user:1", "image", "m1", {}, AbortSignal.abort()), { ok: false, error: "aborted" });
  });

  test("file tool: all five types upload then send using ctx.cwd and count accepted messages", async (t) => {
    const f = await toolFixture(t);
    assert.match(f.tools.get("whatsapp_send").description, /whatsapp_send_file/);
    assert.deepEqual(f.tools.get("whatsapp_send_file").annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    for (const [ext, type] of [["png", "image"], ["mp4", "video"], ["opus", "audio"], ["pdf", "document"], ["webp", "sticker"]]) {
      await writeFile(path.join(f.cwd, `file.${ext}`), Buffer.from([0, 255, 128, 0]));
      const result = await f.execute({ path: `file.${ext}`, ...(type === "document" ? { caption: "report", filename: "display.pdf" } : {}) });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.details.type, type);
      assert.equal(f.mock.received.sends.at(-1)[type].id, "media-upload-1");
      if (type === "document") assert.equal(f.mock.received.sends.at(-1).document.filename, "display.pdf");
    }
    assert.deepEqual(f.mock.received.events, Array.from({ length: 5 }, () => ["upload", "message"]).flat());
    assert.equal(await f.sentCount(), 5);
    assert.equal(f.mock.received.polls, 0);
    await writeFile(path.join(f.cwd, "original.zip"), "binary");
    assert.notEqual((await f.execute({ path: path.join(f.cwd, "original.zip") })).isError, true);
    assert.equal(f.mock.received.sends.at(-1).document.filename, "original.zip");
  });

  test("file tool: missing token, recipient, file and invalid options fail before upload", async (t) => {
    const f = await toolFixture(t);
    const file = path.join(f.cwd, "voice.opus");
    await writeFile(file, "audio");
    await rm(f.configPath);
    assert.match((await f.execute({ path: file })).content[0].text, /No WhatsApp API token/);
    await writeFile(f.configPath, JSON.stringify({ token: "fake" }));
    await rm(f.statePath);
    assert.match((await f.execute({ path: file })).content[0].text, /No recipient known yet/);
    await writeFile(f.statePath, JSON.stringify({ creator: "user:1" }));
    assert.match((await f.execute({ path: "missing.pdf" })).content[0].text, /File not found/);
    assert.match((await f.execute({ path: file, caption: "unsupported" })).content[0].text, /Captions/);
    assert.match((await f.execute({ path: file, filename: "audio.pdf" })).content[0].text, /Filename/);
    assert.match((await f.execute({ path: f.cwd })).content[0].text, /regular file/);
    assert.match((await f.execute({ path: file }, AbortSignal.abort())).content[0].text, /cancelled/);
    assert.equal(f.mock.received.uploadAttempts, 0);
    assert.equal(await f.sentCount(), 0);
  });

  test("file tool: oversize files and document rename path fail locally", async (t) => {
    const f = await toolFixture(t);
    await writeFile(path.join(f.cwd, "too-big.webp"), Buffer.alloc(500_001));
    assert.match((await f.execute({ path: "too-big.webp" })).content[0].text, /500,000 bytes/);
    await writeFile(path.join(f.cwd, "file.pdf"), "pdf");
    assert.match((await f.execute({ path: "file.pdf", filename: "../renamed.pdf" })).content[0].text, /display name/);
    assert.equal(f.mock.received.uploadAttempts, 0);
    assert.equal(await f.sentCount(), 0);
  });

  test("file tool: extensionless renames fail before upload when source has an extension", async (t) => {
    const f = await toolFixture(t);
    await writeFile(path.join(f.cwd, "report.pdf"), "pdf");
    for (const filename of ["report", "report.", ".report", "report.  "]) {
      const result = await f.execute({ path: "report.pdf", filename });
      assert.equal(result.isError, true);
      assert.equal(result.details.stage, "file");
      assert.match(result.content[0].text, /must include.*extension/);
    }
    assert.equal(f.mock.received.uploadAttempts, 0);
    assert.equal(f.mock.received.sendAttempts, 0);
    assert.equal(await f.sentCount(), 0);
    assert.notEqual((await f.execute({ path: "report.pdf", filename: "renamed.pdf" })).isError, true);
    assert.equal(f.mock.received.sends.at(-1).document.filename, "renamed.pdf");
  });

  test("file tool: genuinely extensionless generic documents remain supported", async (t) => {
    const f = await toolFixture(t);
    await writeFile(path.join(f.cwd, "README"), "extensionless document");
    for (const filename of [undefined, "notes", "notes.txt"]) {
      const result = await f.execute({ path: "README", ...(filename === undefined ? {} : { filename }) });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.details.type, "document");
      assert.equal(f.mock.received.sends.at(-1).document.filename, filename ?? "README");
    }
    assert.equal(await f.sentCount(), 3);
  });

  test("file tool: transient upload and message errors retry without extra uploads", async (t) => {
    const f = await toolFixture(t, {
      uploadError: { status: 429, body: { error: { code: 130429 } }, times: 1 },
      sendError: { status: 500, body: { error: { code: 2 } }, times: 1 },
    });
    await writeFile(path.join(f.cwd, "file.png"), "image");
    const result = await f.execute({ path: "file.png" });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(f.mock.received.uploadAttempts, 2);
    assert.equal(f.mock.received.sendAttempts, 2);
    assert.deepEqual(f.mock.received.events, ["upload", "upload", "message", "message"]);
    assert.equal(f.mock.received.sends[0].image.id, "media-upload-1");
    assert.equal(await f.sentCount(), 1);
  });

  test("file tool: malformed upload success never proceeds to message", async (t) => {
    const f = await toolFixture(t, { uploadResponse: { id: "" } });
    await writeFile(path.join(f.cwd, "file.png"), "image");
    const result = await f.execute({ path: "file.png" });
    assert.equal(result.isError, true);
    assert.equal(result.details.stage, "upload");
    assert.match(result.content[0].text, /non-empty media ID/);
    assert.equal(f.mock.received.sendAttempts, 0);
    assert.equal(await f.sentCount(), 0);
  });

  test("file tool: partial failure is a send error without re-upload or counter increment", async (t) => {
    const f = await toolFixture(t, { sendError: { status: 400, body: { error: { code: 131009 } } } });
    await writeFile(path.join(f.cwd, "file.png"), "image");
    const result = await f.execute({ path: "file.png" });
    assert.equal(result.isError, true);
    assert.equal(result.details.stage, "send");
    assert.match(result.content[0].text, /unknown or expired/);
    assert.equal(f.mock.received.uploadAttempts, 1);
    assert.equal(f.mock.received.sendAttempts, 1);
    assert.equal(await f.sentCount(), 0);
  });

  test("file tool: upload failure is reported safely and never sends", async (t) => {
    const f = await toolFixture(t, { uploadError: { status: 400, body: { error: { code: 131053, message: "EVIL\u001b[2J" } } } });
    await writeFile(path.join(f.cwd, "file.png"), "image");
    const result = await f.execute({ path: "file.png" });
    assert.equal(result.details.stage, "upload");
    assert.match(result.content[0].text, /size limit.*MIME/);
    assert.doesNotMatch(result.content[0].text, /EVIL|\u001b/);
    assert.equal(f.mock.received.sendAttempts, 0);
    assert.equal(await f.sentCount(), 0);
  });

  test("file tool: cancellation between upload and message prevents sending", async (t) => {
    const f = await toolFixture(t);
    await writeFile(path.join(f.cwd, "file.png"), "image");
    const controller = new AbortController();
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (...args) => {
      const response = await realFetch(...args);
      const realJson = response.json.bind(response);
      response.json = async () => { const body = await realJson(); controller.abort(); return body; };
      return response;
    });
    assert.equal((await f.execute({ path: "file.png" }, controller.signal)).isError, true);
    assert.equal(f.mock.received.uploadAttempts, 1);
    assert.equal(f.mock.received.sendAttempts, 0);
    assert.equal(await f.sentCount(), 0);
  });

  test("pi integration: discovered child tool needs opt-in and config-backed authentication", async (t) => {
    for (const [tools, configToken, expectedActive, expectedSource] of [
      ["read,grep,find,ls", true, false, "file"],
      ["read,grep,find,ls,whatsapp_send_file", true, true, "file"],
      ["read,grep,find,ls,whatsapp_send_file", false, true, "none"],
    ]) {
      const f = await fixture([]);
      const agentDir = path.join(f.dir, "pi-agent");
      await mkdir(path.join(agentDir, "extensions"), { recursive: true });
      await symlink(EXT_DIR, path.join(agentDir, "extensions", "whatsapp"), process.platform === "win32" ? "junction" : "dir");
      if (!configToken) await rm(f.configPath);
      const probe = path.join(f.dir, "probe.ts");
      await writeFile(probe, `import { loadTokenWithSource } from ${JSON.stringify(path.join(EXT_DIR, "util.ts"))};
export default function(pi) {
  pi.registerCommand("wa-test-availability", { handler: async (_args, ctx) => {
    const auth = await loadTokenWithSource(process.env.WA_CONFIG);
    ctx.ui.notify("WA_PROBE=" + JSON.stringify({ active: pi.getActiveTools(), source: auth.source }), "info");
  }});
}`);
      const pi = startPi({ ...f.env, PI_CODING_AGENT_DIR: agentDir, WHATSAPP_AGENT_TOKEN: "", WA_INTERNAL_CHILD: "1" }, ["--extension", probe, "--tools", tools]);
      try {
        pi.child.stdin.write(JSON.stringify({ type: "prompt", message: "/wa-test-availability" }) + "\n");
        const record = await waitFor(() => pi.records.find((r) => typeof r.message === "string" && r.message.startsWith("WA_PROBE=")), { timeoutMs: 30_000 });
        const result = JSON.parse(record.message.slice("WA_PROBE=".length));
        assert.equal(result.active.includes("whatsapp_send_file"), expectedActive);
        assert.equal(result.source, expectedSource);
        assert.equal(f.mock.received.polls, 0);
        assert.equal(f.mock.received.uploadAttempts, 0);
        assert.doesNotMatch(pi.stderr.join(""), /Failed to load extension/);
      } finally {
        await stopPi(pi);
        f.mock.server.closeAllConnections();
        f.mock.server.close();
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  });
}
