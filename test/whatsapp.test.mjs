/**
 * Tests for the WhatsApp extension.
 *
 * Run: node --test test/whatsapp.test.mjs
 *
 * Two layers:
 *  - util/runner/client import only Node builtins, so they are tested directly
 *    through jiti (the loader pi uses), with no build step.
 *  - index.ts imports the pi packages, whose internal resolution only exists
 *    inside pi. It is therefore tested by running real `pi` in RPC mode against
 *    a mock WhatsApp Agent Platform and a stub `pi` binary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { findJiti, findPiBin } from "./resolve.mjs";

const require = createRequire(import.meta.url);

const PI_BIN = findPiBin();
const EXT_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { createJiti } = require(findJiti());
const jiti = createJiti(path.join(EXT_DIR, "util.ts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- helpers

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}

/**
 * A stub standing in for the `pi` binary: records how the extension invoked it,
 * then prints a reply the way `pi --print` would.
 */
async function writeStub(dir) {
  const record = path.join(dir, "stub-record.jsonl");
  const bin = path.join(dir, "pi-stub.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    PI_SESSION_ID: process.env.PI_SESSION_ID ?? null,
    PI_MODEL: process.env.PI_MODEL ?? null,
    WHATSAPP_AGENT_TOKEN: process.env.WHATSAPP_AGENT_TOKEN ?? null,
    WA_INTERNAL_CHILD: process.env.WA_INTERNAL_CHILD ?? null,
  },
}) + "\\n");
process.stdout.write("stub reply");
`,
  );
  await chmod(bin, 0o755);
  return { bin, record };
}

/** Minimal stand-in for the WhatsApp Agent Platform. */
function startMockServer({ messages, updatesError, sendError, mediaUrl, alwaysEmpty, conflicts }) {
  const received = { sends: [], statuses: [], polls: 0, mediaMeta: 0, mediaFetches: 0, sendAttempts: 0 };
  let served = 0;
  let conflictCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/blob.jpg") {
      received.mediaFetches++;
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(Buffer.from([1, 2, 3]));
      return;
    }

    if (req.method === "GET" && url.pathname.includes("/agent/v1/media/")) {
      received.mediaMeta++;
      const port = server.address().port;
      return json(200, {
        url: mediaUrl ?? `http://127.0.0.1:${port}/blob.jpg`,
        mime_type: "image/jpeg",
      });
    }

    if (req.method === "GET" && url.pathname.endsWith("/agent/v1/updates")) {
      received.polls++;
      // `times` fails only the first N polls, so a test can watch recovery.
      if (updatesError && (updatesError.times === undefined || received.polls <= updatesError.times)) {
        return json(updatesError.status, updatesError.body);
      }
      // `conflicts` answers the first N polls with the documented 409.
      if (conflicts !== undefined && conflictCount++ < conflicts) {
        return json(409, { error: { code: 1752041, message: "Duplicate request" } });
      }
      // `alwaysEmpty` makes the first successful poll a 204, so only the 204
      // branch can clear an error status.
      if (alwaysEmpty) {
        res.writeHead(204);
        return res.end();
      }
      if (served++ === 0) {
        return json(200, {
          object: "whatsapp_agent_platform",
          entry: [
            {
              id: "123456789",
              changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages } }],
            },
          ],
          next_offset: 5,
        });
      }
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "POST" && url.pathname.endsWith("/agent/v1/statuses")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.statuses.push(JSON.parse(body));
        json(200, { success: true });
      });
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/agent/v1/messages")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        received.sendAttempts++;
        if (sendError && (sendError.times === undefined || received.sendAttempts <= sendError.times)) {
          // A string body is sent raw, so a test can place a marker at the very
          // start of the peer-controlled error text.
          const raw = typeof sendError.body === "string";
          res.writeHead(sendError.status, {
            "Content-Type": raw ? "text/plain" : "application/json",
          });
          return res.end(raw ? sendError.body : JSON.stringify(sendError.body));
        }
        received.sends.push(parsed);
        json(200, {
          messaging_product: "whatsapp",
          contacts: [{ input: parsed.to, wa_id: parsed.to }],
          messages: [{ id: `wamid.out.${received.sends.length}` }],
        });
      });
      return;
    }

    json(404, { error: { message: "not found" } });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

/** Start real pi in RPC mode and collect its protocol records and stderr. */
// Loaded explicitly rather than by discovery, so the suite exercises THIS working
// tree instead of whatever copy happens to be installed in the agent directory —
// and so other installed extensions cannot influence the run.
function startPi(env, extraArgs = ["--whatsapp", "--extension", path.join(EXT_DIR, "index.ts")]) {
  const child = spawn(PI_BIN, ["--mode", "rpc", "--no-session", ...extraArgs], {
    cwd: env.WA_PI_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const records = [];
  const stderr = [];
  let buffer = "";

  child.stdout.on("data", (d) => {
    buffer += d.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Not a protocol record; ignore.
      }
    }
  });
  child.stderr.on("data", (d) => stderr.push(d.toString()));

  return { child, records, stderr, text: () => JSON.stringify(records) + stderr.join("") };
}

async function stopPi(pi) {
  pi.child.stdin.end();
  await Promise.race([
    new Promise((r) => pi.child.once("close", r)),
    sleep(15_000).then(() => pi.child.kill("SIGKILL")),
  ]);
}

async function exists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/** Shared fixture: temp dirs, stub pi, mock server. */
async function fixture(messages, mockOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-test-"));
  const { bin, record } = await writeStub(dir);
  const configPath = path.join(dir, "config.json");
  const statePath = path.join(dir, "state.json");
  const lockPath = path.join(dir, "whatsapp.lock");
  const agentCwd = path.join(dir, "agent");
  // The host pi process is spawned with this cwd, so it must exist up front.
  // The extension creates it too, for the child pi it runs per message.
  await mkdir(agentCwd, { recursive: true });
  await writeFile(configPath, JSON.stringify({ token: "test-token" }));

  const mock = await startMockServer({ messages, ...mockOptions });

  return {
    dir,
    bin,
    record,
    configPath,
    statePath,
    lockPath,
    agentCwd,
    mock,
    env: {
      WA_BASE_URL: `http://127.0.0.1:${mock.port}/agent/v1`,
      WA_CONFIG: configPath,
      WA_STATE: statePath,
      WA_LOCK: lockPath,
      WA_PI_CWD: agentCwd,
      WA_PI_BIN: bin,
      WA_PI_TOOLS: "read",
      WA_PI_TIMEOUT_MS: "20000",
    },
  };
}

// --------------------------------------------------------- unit: util, runner

test("util: chunk respects the 4096-character API cap", () => {
  const { chunk } = jiti(path.join(EXT_DIR, "util.ts"));

  const long = "word ".repeat(3000).trim();
  const parts = chunk(long);
  assert.ok(parts.length > 1, "long text is split");
  assert.ok(
    parts.every((p) => p.length <= 4000),
    `every part fits (max ${Math.max(...parts.map((p) => p.length))})`,
  );
  assert.equal(
    parts.join(" ").split(/\s+/).join(" "),
    long.split(/\s+/).join(" "),
    "content survives chunking",
  );

  assert.deepEqual(chunk(""), []);
  assert.deepEqual(chunk("hi"), ["hi"]);
  assert.equal(chunk("a".repeat(3000) + "\n\n" + "b".repeat(3000))[0].length, 3000, "cuts on paragraph");
});

test("util: sessionIdFor produces a legal, stable, unique pi session id", () => {
  const { sessionIdFor } = jiti(path.join(EXT_DIR, "util.ts"));

  const id = sessionIdFor("user:50972923564215");
  assert.match(id, /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, "pi session-id rule");
  assert.equal(id, sessionIdFor("user:50972923564215"), "stable");
  assert.notEqual(sessionIdFor("user:1"), sessionIdFor("user:2"), "distinct per participant");
});

test("util: lockfile takes over a stale holder and releases cleanly", async () => {
  const { acquireLock, releaseLock } = jiti(path.join(EXT_DIR, "util.ts"));
  const dir = await mkdtemp(path.join(tmpdir(), "wa-lock-"));
  const lockPath = path.join(dir, "test.lock");

  assert.equal((await acquireLock(lockPath, "test-1")).ok, true);

  // A live holder must be refused. pid 1 always exists; for a non-root process
  // signalling it raises EPERM rather than ESRCH, which must still count as alive.
  await writeFile(lockPath, JSON.stringify({ pid: 1, kind: "standalone bridge", startedAt: "" }));
  const refused = await acquireLock(lockPath, "test-2");
  assert.equal(refused.ok, false, "a live holder is respected");
  assert.equal(refused.holder.kind, "standalone bridge");

  // A lock from a dead pid is stale and must be stolen.
  await writeFile(lockPath, JSON.stringify({ pid: 999999, kind: "ghost", startedAt: "" }));
  assert.equal((await acquireLock(lockPath, "test-3")).ok, true, "stale lock taken over");

  await releaseLock(lockPath);
  assert.equal(await exists(lockPath), false, "release removes the lock");
});

test("runner: scrubs parent session env and marks the child", async () => {
  const { runPi } = jiti(path.join(EXT_DIR, "runner.ts"));
  const dir = await mkdtemp(path.join(tmpdir(), "wa-runner-"));
  const { bin, record } = await writeStub(dir);

  // Simulate pi's shell-tool session metadata leaking into the extension process.
  process.env.PI_SESSION_ID = "parent-session-must-not-leak";
  process.env.PI_MODEL = "parent-model-must-not-leak";

  try {
    const result = await runPi({
      prompt: "hello",
      sessionId: "wa-test",
      name: "wa test",
      cwd: dir,
      piBin: bin,
      tools: "read",
      timeoutMs: 10_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.text, "stub reply");

    const [invocation] = (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(invocation.argv, [
      "--print",
      "--session-id",
      "wa-test",
      "-n",
      "wa test",
      "--tools",
      "read",
      "--",
      "hello",
    ]);
    assert.equal(invocation.env.PI_SESSION_ID, null, "PI_SESSION_ID must not be inherited");
    assert.equal(invocation.env.WA_INTERNAL_CHILD, "1", "child is marked to prevent recursion");
  } finally {
    delete process.env.PI_SESSION_ID;
    delete process.env.PI_MODEL;
  }
});

test("client: long-poll, typing indicator, send, and permanent-failure handling", async () => {
  const { WhatsAppClient } = jiti(path.join(EXT_DIR, "client.ts"));
  const dir = await mkdtemp(path.join(tmpdir(), "wa-client-"));

  // Point the module's base URL at the mock by importing a fresh registry.
  const localJiti = createJiti(path.join(EXT_DIR, "client.ts"), { moduleCache: false });
  const mock = await startMockServer({
    messages: [
      { from: "user:1", id: "wamid.1", timestamp: "1", type: "text", text: { body: "hi" } },
    ],
  });
  process.env.WA_BASE_URL = `http://127.0.0.1:${mock.port}/agent/v1`;

  try {
    const { WhatsAppClient: C } = localJiti(path.join(EXT_DIR, "client.ts"));
    assert.ok(WhatsAppClient && C, "client module loads");

    const client = new C("test-token");

    const first = await client.poll(undefined);
    assert.equal(first.kind, "updates");
    assert.equal(first.nextOffset, 5);
    assert.equal(first.messages[0].text.body, "hi");

    const second = await client.poll(first.nextOffset);
    assert.equal(second.kind, "empty", "204 means nothing new");

    assert.equal(await client.markRead("wamid.1"), undefined, "best-effort, returns nothing");
    assert.equal(
      mock.received.statuses[0].typing_indicator.type,
      "text",
      "typing indicator requested",
    );

    const sent = await client.sendText("user:1", "hello back");
    assert.equal(sent.ok, true);
    assert.equal(mock.received.sends[0].text.body, "hello back");
  } finally {
    delete process.env.WA_BASE_URL;
    mock.server.close();
  }
});

// ------------------------------------------------- integration: real pi, RPC

test("pi integration: answers an inbound WhatsApp message end to end", async () => {
  const f = await fixture([
    {
      from: "user:50972923564215",
      id: "wamid.in.1",
      timestamp: "1736844652",
      type: "text",
      text: { body: "hello from whatsapp" },
    },
  ]);

  const pi = startPi(f.env);
  try {
    // The extension announces itself through the RPC UI protocol.
    await waitFor(() => f.mock.received.polls > 0, { timeoutMs: 30_000 });

    const send = await waitFor(() => f.mock.received.sends[0], { timeoutMs: 30_000 });
    assert.equal(send.to, "user:50972923564215", "replies to the sender");
    assert.equal(send.type, "text");
    assert.equal(send.text.body, "stub reply", "delivers the child pi output");

    assert.ok(
      f.mock.received.statuses.some(
        (s) => s.message_id === "wamid.in.1" && s.typing_indicator?.type === "text",
      ),
      "shows a typing indicator",
    );

    // The child ran in its own session with the WhatsApp text as the prompt.
    const [invocation] = (await readFile(f.record, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(invocation.argv.includes("--session-id"), "child gets a session id");
    const sessionId = invocation.argv[invocation.argv.indexOf("--session-id") + 1];
    assert.match(sessionId, /^wa-user-50972923564215-[0-9a-f]{6}$/, `session id: ${sessionId}`);
    assert.equal(invocation.argv.at(-1), "hello from whatsapp", "prompt is the WhatsApp text");

    // The workspace is self-provisioning: the persona is seeded on first start.
    const persona = await readFile(path.join(f.agentCwd, "AGENTS.md"), "utf8");
    assert.match(persona, /^# WhatsApp agent/, "a default persona was written");
    assert.match(persona, /phone chat, not a terminal/, "the persona carries the reply rules");

    // The footer shows a short, plain label while running.
    const footers = waStatuses(pi);
    assert.ok(
      footers.includes("whatsapp: connected"),
      `expected the footer to read "whatsapp: connected", got ${JSON.stringify(footers)}`,
    );
    assert.ok(
      !footers.some((t) => /wa off|wa listening|○|●/.test(t)),
      "the footer carries no dotted status marker",
    );

    // Offset persisted so a restart resumes instead of replaying.
    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(state.next_offset, 5);

    assert.ok(await exists(f.lockPath), "lock held while listening");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }

  // Shutdown released the lock.
  assert.equal(await exists(f.lockPath), false, "lock released on shutdown");
});

test("pi integration: refuses to start when another poller holds the lock", async () => {
  const f = await fixture([]);

  // A live foreign holder: pid 1 always exists and is not this process.
  await writeFile(f.lockPath, JSON.stringify({ pid: 1, kind: "standalone bridge", startedAt: "" }));

  const pi = startPi(f.env);
  try {
    const message = await waitFor(
      () => (/another WhatsApp poller/i.test(pi.text()) ? pi.text() : null),
      { timeoutMs: 30_000 },
    );
    assert.match(message, /another WhatsApp poller/i);

    // Being asked for and failing is visible, not silently identical to "off".
    const footers = waStatuses(pi);
    assert.ok(
      footers.includes("whatsapp: another poller is running"),
      `expected the footer to explain the refusal, got ${JSON.stringify(footers)}`,
    );

    assert.equal(f.mock.received.polls, 0, "never polled");
    assert.equal(f.mock.received.sends.length, 0, "never sent");

    const holder = JSON.parse(await readFile(f.lockPath, "utf8"));
    assert.equal(holder.kind, "standalone bridge", "does not steal the holder's lock");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }

  assert.equal(await exists(f.lockPath), true, "shutdown leaves a lock it never held");
});

test("pi integration: /whatsapp doctor diagnoses a rejected token", async () => {
  const f = await fixture([], {
    updatesError: {
      status: 400,
      body: {
        error: { message: "Invalid or missing Authorization Bearer token", code: 100, type: "OAuthException" },
      },
    },
  });

  // No --whatsapp: the extension is loaded but not polling, so the doctor is
  // allowed to run its live probe.
  const pi = startPi(f.env, []);
  try {
    pi.child.stdin.write(`${JSON.stringify({ id: "d1", type: "prompt", message: "/whatsapp doctor" })}\n`);

    const text = await waitFor(() => (/1 check\(s\) failed/.test(pi.text()) ? pi.text() : null), {
      timeoutMs: 30_000,
    });

    assert.match(text, /✓ token: Found in/, "reports where the token came from");
    assert.match(text, /✗ api: HTTP 400 \/ code 100/, "names the status and platform code");
    assert.match(text, /Regenerate it in WhatsApp/, "states the fix");
    assert.match(text, /✗|! api/, "api check is not marked ok");

    // A failing report must surface as an error notification, not an info toast.
    const notify = pi.records.find(
      (r) => r.type === "extension_ui_request" && r.method === "notify" && /check\(s\) failed/.test(r.message ?? ""),
    );
    assert.ok(notify, "doctor result was delivered as a notification");
    assert.equal(notify.notifyType, "error", "failures notify as errors");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

// ----------------------------------------------------------------- doctor

/**
 * doctor.ts imports only client.ts and util.ts, so it is testable directly.
 * The base URL is read at import time, so load it after pointing WA_BASE_URL
 * at the mock.
 */
async function loadDoctor(baseUrl) {
  if (baseUrl) process.env.WA_BASE_URL = baseUrl;
  const localJiti = createJiti(path.join(EXT_DIR, "doctor.ts"), { moduleCache: false });
  return localJiti(path.join(EXT_DIR, "doctor.ts"));
}

/** A directory where the doctor's path checks will succeed. */
async function doctorDir(extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-doctor-"));
  const agentCwd = path.join(dir, "agent");
  await mkdir(agentCwd, { recursive: true });
  return {
    token: "test-token",
    tokenSource: "file",
    configPath: path.join(dir, "config.json"),
    statePath: path.join(dir, "state.json"),
    lockPath: path.join(dir, "whatsapp.lock"),
    agentCwd,
    piBin: await (async () => (await writeStub(dir)).bin)(),
    tools: "read",
    model: "",
    listening: false,
    ...extra,
  };
}

const checkFor = (report, name) => report.checks.find((c) => c.name === name);

test("doctor: reports a healthy setup and touches nothing", async () => {
  const mock = await startMockServer({ messages: [] });
  try {
    const { runDoctor } = await loadDoctor(`http://127.0.0.1:${mock.port}/agent/v1`);
    const report = await runDoctor(await doctorDir());

    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(checkFor(report, "token").status, "ok");
    assert.match(checkFor(report, "api").detail, /reachable, token accepted/);
    assert.equal(checkFor(report, "lock").status, "ok");
    assert.equal(checkFor(report, "pi").status, "ok");
    assert.equal(checkFor(report, "workspace").status, "ok");
    // No persona yet in a fresh workspace: a warning, not a failure.
    assert.equal(checkFor(report, "persona").status, "warn");
    assert.match(checkFor(report, "persona").detail, /default persona is written/);

    // Read-only: no messages sent, no offsets consumed, nothing left behind.
    assert.equal(mock.received.sends.length, 0, "doctor never sends");
    assert.equal(mock.received.statuses.length, 0, "doctor never marks read");
  } finally {
    mock.server.close();
    delete process.env.WA_BASE_URL;
  }
});

test("doctor: surfaces an invalid token as a failure with the fix", async () => {
  const mock = await startMockServer({
    updatesError: {
      status: 400,
      body: { error: { message: "Invalid or missing Authorization Bearer token", code: 100, type: "OAuthException" } },
    },
  });
  try {
    const { runDoctor } = await loadDoctor(`http://127.0.0.1:${mock.port}/agent/v1`);
    const report = await runDoctor(await doctorDir());

    assert.equal(report.ok, false);
    const api = checkFor(report, "api");
    assert.equal(api.status, "fail");
    assert.match(api.detail, /HTTP 400 \/ code 100/);
    assert.match(api.detail, /Regenerate it in WhatsApp/, "names the fix");
  } finally {
    mock.server.close();
    delete process.env.WA_BASE_URL;
  }
});

test("doctor: distinguishes an unreachable endpoint from a rejected token", async () => {
  // A port nothing is listening on.
  const { runDoctor } = await loadDoctor("http://127.0.0.1:9/agent/v1");
  const report = await runDoctor(await doctorDir());

  assert.equal(report.ok, false);
  const api = checkFor(report, "api");
  assert.equal(api.status, "fail");
  assert.match(api.detail, /Cannot reach/, "reports reachability, not credentials");

  delete process.env.WA_BASE_URL;
});

test("doctor: reports a missing token without attempting the network", async () => {
  const { runDoctor } = await loadDoctor("http://127.0.0.1:9/agent/v1");
  const report = await runDoctor(await doctorDir({ token: undefined, tokenSource: "none" }));

  assert.equal(report.ok, false);
  assert.equal(checkFor(report, "token").status, "fail");
  assert.match(checkFor(report, "token").detail, /WHATSAPP_AGENT_TOKEN/);
  assert.equal(checkFor(report, "api").status, "warn", "skips the probe rather than failing twice");

  delete process.env.WA_BASE_URL;
});

test("doctor: skips the network probe while the listener is running", async () => {
  const mock = await startMockServer({ messages: [] });
  try {
    const { runDoctor } = await loadDoctor(`http://127.0.0.1:${mock.port}/agent/v1`);
    const report = await runDoctor(await doctorDir({ listening: true }));

    assert.equal(checkFor(report, "api").status, "ok");
    assert.match(checkFor(report, "api").detail, /skipped the probe/);
    assert.equal(mock.received.polls, 0, "a probe would have replaced the live poll with a 409");
  } finally {
    mock.server.close();
    delete process.env.WA_BASE_URL;
  }
});

test("doctor: warns about a competing poller and about a missing pi binary", async () => {
  const mock = await startMockServer({ messages: [] });
  try {
    const { runDoctor } = await loadDoctor(`http://127.0.0.1:${mock.port}/agent/v1`);
    const options = await doctorDir({ piBin: "/nonexistent/pi-binary" });

    await writeFile(
      options.lockPath,
      JSON.stringify({ pid: 1, kind: "standalone bridge", startedAt: "2026-01-01T00:00:00Z" }),
    );

    const report = await runDoctor(options);
    assert.equal(report.ok, false, "a missing pi binary is fatal");

    const lock = checkFor(report, "lock");
    assert.equal(lock.status, "warn");
    assert.match(lock.detail, /standalone bridge/);
    assert.match(lock.detail, /Only one poller may run per agent/);

    const pi = checkFor(report, "pi");
    assert.equal(pi.status, "fail");
    assert.match(pi.detail, /Cannot run/);
  } finally {
    mock.server.close();
    delete process.env.WA_BASE_URL;
  }
});

test("doctor: formatReport marks each check and summarises", async () => {
  const { formatReport } = await loadDoctor();
  const text = formatReport({
    ok: false,
    checks: [
      { name: "token", status: "ok", detail: "fine" },
      { name: "api", status: "warn", detail: "hmm" },
      { name: "pi", status: "fail", detail: "broken" },
    ],
  });

  assert.match(text, /✓ token: fine/);
  assert.match(text, /! api: hmm/);
  assert.match(text, /✗ pi: broken/);
  assert.match(text, /— 1 check\(s\) failed/);

  assert.match(
    formatReport({ ok: true, checks: [{ name: "a", status: "ok", detail: "d" }] }),
    /— all checks passed/,
  );
  assert.match(
    formatReport({ ok: true, checks: [{ name: "a", status: "warn", detail: "d" }] }),
    /— ready, with 1 warning\(s\)/,
  );

  delete process.env.WA_BASE_URL;
});

// --------------------------------------------------------------- sessions

test("sessions: forget removes only the target conversation", async () => {
  const s = jiti(path.join(EXT_DIR, "sessions.ts"));
  const root = await mkdtemp(path.join(tmpdir(), "wa-sessions-"));
  const projA = path.join(root, "--proj-a--");
  const projB = path.join(root, "--proj-b--");
  await mkdir(projA, { recursive: true });
  await mkdir(projB, { recursive: true });

  const target = "wa-user-1-abc123";
  const targetFile = path.join(projA, `2026-01-01T00-00-00-000Z_${target}.jsonl`);
  const sameIdOtherProject = path.join(projB, `2026-01-01T00-00-00-000Z_${target}.jsonl`);
  const otherConversation = path.join(projA, "2026-01-01T00-00-00-000Z_wa-user-2-def456.jsonl");
  const normalSession = path.join(projA, "2026-01-01T00-00-00-000Z_my-coding-session.jsonl");

  for (const f of [targetFile, sameIdOtherProject, otherConversation, normalSession]) {
    await writeFile(f, "x".repeat(100));
  }

  const found = await s.findSessionFiles(target, root);
  assert.equal(found.length, 2, "finds the same id across project groups");

  const result = await s.forgetConversation(target, root);
  assert.equal(result.files, 2);
  assert.equal(result.bytes, 200, "counts the bytes it removed");

  assert.equal(await exists(targetFile), false, "target removed");
  assert.equal(await exists(sameIdOtherProject), false, "target removed in every project group");
  assert.equal(await exists(otherConversation), true, "another conversation survives");
  assert.equal(await exists(normalSession), true, "a non-WhatsApp session survives");
});

test("sessions: forget all spares non-WhatsApp sessions", async () => {
  const s = jiti(path.join(EXT_DIR, "sessions.ts"));
  const root = await mkdtemp(path.join(tmpdir(), "wa-sessions-all-"));
  const proj = path.join(root, "--proj--");
  await mkdir(proj, { recursive: true });

  const waFiles = [
    path.join(proj, "2026-01-01T00-00-00-000Z_wa-user-1-aaa111.jsonl"),
    path.join(proj, "2026-01-01T00-00-00-000Z_wa-user-2-bbb222.jsonl"),
  ];
  const keep = [
    path.join(proj, "2026-01-01T00-00-00-000Z_my-coding-session.jsonl"),
    path.join(proj, "2026-01-01T00-00-00-000Z_wa-not-a-user-session.jsonl"),
  ];
  for (const f of [...waFiles, ...keep]) await writeFile(f, "y".repeat(10));

  const result = await s.forgetAllConversations(root);
  assert.equal(result.files, 2, "only wa-user-* files are forgotten");
  for (const f of waFiles) assert.equal(await exists(f), false, `removed ${path.basename(f)}`);
  for (const f of keep) assert.equal(await exists(f), true, `kept ${path.basename(f)}`);
});

test("sessions: inbox stats, clearing, and byte formatting", async () => {
  const s = jiti(path.join(EXT_DIR, "sessions.ts"));
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "wa-inbox-")), ".wa-inbox");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "a.jpg"), Buffer.alloc(1500));
  await writeFile(path.join(dir, "b.pdf"), Buffer.alloc(500));

  assert.deepEqual(await s.inboxStats(dir), { files: 2, bytes: 2000 });

  const cleared = await s.clearInbox(dir);
  assert.equal(cleared.files, 2, "reports what it cleared");
  assert.deepEqual(await s.inboxStats(dir), { files: 0, bytes: 0 });

  // Missing directories are not an error.
  assert.deepEqual(await s.inboxStats(path.join(dir, "nope")), { files: 0, bytes: 0 });
  assert.deepEqual(await s.clearInbox(path.join(dir, "nope")), { files: 0, bytes: 0 });

  assert.equal(s.formatBytes(512), "512 B");
  assert.equal(s.formatBytes(2048), "2.0 KB");
  assert.equal(s.formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("sessions: root resolution follows pi's precedence", () => {
  const s = jiti(path.join(EXT_DIR, "sessions.ts"));
  const saved = {
    dir: process.env.PI_CODING_AGENT_SESSION_DIR,
    agent: process.env.PI_CODING_AGENT_DIR,
  };

  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = "/custom/sessions";
    process.env.PI_CODING_AGENT_DIR = "/custom/agent";
    assert.equal(s.sessionsRoot(), "/custom/sessions", "session dir wins over agent dir");

    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    assert.equal(s.sessionsRoot(), path.join("/custom/agent", "sessions"), "falls back to agent dir");

    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(
      s.sessionsRoot(),
      path.join(homedir(), ".pi/agent", "sessions"),
      "defaults to ~/.pi/agent/sessions",
    );
  } finally {
    for (const [key, value] of [
      ["PI_CODING_AGENT_SESSION_DIR", saved.dir],
      ["PI_CODING_AGENT_DIR", saved.agent],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("pi integration: /whatsapp forget clears one conversation and media", async () => {
  const f = await fixture([
    {
      from: "user:50972923564215",
      id: "wamid.in.1",
      timestamp: "1736844652",
      type: "text",
      text: { body: "remember this" },
    },
  ]);

  // Point the sessions root somewhere disposable, so the test never touches the
  // real session store. The extension and its child pi share this path.
  const sessionsRoot = path.join(f.dir, "sessions");
  const projectDir = path.join(sessionsRoot, "--fake-project--");
  await mkdir(projectDir, { recursive: true });

  // The stub pi creates no session file, so stand in for the real child's
  // transcript, plus a decoy that must survive.
  const { sessionIdFor } = jiti(path.join(EXT_DIR, "util.ts"));
  const sessionId = sessionIdFor("user:50972923564215");
  const conversation = path.join(projectDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const decoy = path.join(projectDir, "2026-01-01T00-00-00-000Z_wa-user-999-999999.jsonl");
  await writeFile(conversation, "z".repeat(2048));
  await writeFile(decoy, "z".repeat(64));

  // Attachments are filed per conversation, plus a decoy conversation whose
  // media must survive a single-conversation forget.
  const inbox = path.join(f.agentCwd, ".wa-inbox");
  const convMedia = path.join(inbox, sessionId);
  const otherMedia = path.join(inbox, "wa-user-999-999999");
  await mkdir(convMedia, { recursive: true });
  await mkdir(otherMedia, { recursive: true });
  await writeFile(path.join(convMedia, "photo.jpg"), Buffer.alloc(4096));
  await writeFile(path.join(otherMedia, "keep.jpg"), Buffer.alloc(1024));

  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

  const pi = startPi(f.env);
  try {
    // Wait until a message has been handled, so the extension knows its creator.
    await waitFor(() => f.mock.received.sends[0], { timeoutMs: 30_000 });

    pi.child.stdin.write(`${JSON.stringify({ id: "f1", type: "prompt", message: "/whatsapp forget" })}\n`);
    const forgot = await waitFor(
      () => (/Forgot this conversation/.test(pi.text()) ? pi.text() : null),
      { timeoutMs: 30_000 },
    );

    // The transcript and the media it referenced go together.
    assert.match(forgot, /Forgot this conversation: 1 transcript and 1 attachment, 6\.0 KB/);
    assert.match(forgot, /WhatsApp history is untouched/, "sets expectations about WhatsApp");

    assert.equal(await exists(conversation), false, "the conversation transcript is gone");
    assert.equal(await exists(convMedia), false, "this conversation's attachments are gone");
    assert.equal(await exists(decoy), true, "another conversation's transcript is untouched");
    assert.equal(
      await exists(path.join(otherMedia, "keep.jpg")),
      true,
      "another conversation's attachments are untouched",
    );

    // The blunt instrument still clears everything, including orphans.
    pi.child.stdin.write(`${JSON.stringify({ id: "f2", type: "prompt", message: "/whatsapp forget media" })}\n`);
    const media = await waitFor(
      () => (/Cleared 1 attachment/.test(pi.text()) ? pi.text() : null),
      { timeoutMs: 30_000 },
    );
    assert.match(media, /Cleared 1 attachment\(s\) \(1\.0 KB\) from every conversation/);
    assert.deepEqual(
      await (await import("node:fs/promises")).readdir(inbox),
      [],
      "the inbox is empty",
    );
  } finally {
    await stopPi(pi);
    f.mock.server.close();
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  }
});

// ------------------------------------------------------------------ media

test("media: an image prompt ends with the @path and nothing after it", () => {
  const m = jiti(path.join(EXT_DIR, "media.ts"));
  const rel = ".wa-inbox/abc.jpg";
  const prompt = m.buildAttachmentPrompt({ type: "image", rel, caption: "look at this" });

  // `@path` consumes to the end of the argument, so anything after it is absorbed
  // into the filename and the whole prompt is lost.
  assert.ok(prompt.endsWith(`@${rel}`), "the @path token must be final");
  assert.equal(prompt.indexOf(`@${rel}`), prompt.length - rel.length - 1, "nothing follows it");
  assert.equal(prompt.split("@").length - 1, 1, "exactly one @ when the caption has none");

  assert.match(prompt, /The user sent an image\./);
  assert.match(prompt, /Caption: look at this/);
});

test("media: only images are attached; other types keep the path in prose", () => {
  const m = jiti(path.join(EXT_DIR, "media.ts"));
  const rel = ".wa-inbox/x.bin";

  for (const type of ["document", "video", "audio", "sticker", "unknown-type"]) {
    const prompt = m.buildAttachmentPrompt({ type, rel, filename: "report.pdf" });
    assert.ok(!prompt.includes("@"), `${type} must not emit an @ token`);
    assert.ok(prompt.includes(rel), `${type} still names the path for the read tool`);
  }

  assert.match(
    m.buildAttachmentPrompt({ type: "document", rel, filename: "report.pdf" }),
    /report\.pdf/,
    "documents name the file",
  );
  assert.match(
    m.buildAttachmentPrompt({ type: "audio", rel, voice: true }),
    /voice note.*cannot hear audio/s,
    "voice notes are called out as unhearable",
  );
  assert.match(m.buildAttachmentPrompt({ type: "audio", rel, voice: false }), /audio file/);
  assert.match(m.buildAttachmentPrompt({ type: "video", rel }), /sent a video/);
});

// ------------------------------------------------- media lifecycle & orphans

test("sessions: each conversation's media is filed separately and forgotten together", async () => {
  const s = jiti(path.join(EXT_DIR, "sessions.ts"));
  const agentCwd = await mkdtemp(path.join(tmpdir(), "wa-media-"));

  const a = "wa-user-1-aaa111";
  const b = "wa-user-2-bbb222";
  const dirA = s.mediaDirFor(agentCwd, a);
  const dirB = s.mediaDirFor(agentCwd, b);
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await writeFile(path.join(dirA, "one.jpg"), Buffer.alloc(1000));
  await writeFile(path.join(dirA, "two.pdf"), Buffer.alloc(500));
  await writeFile(path.join(dirB, "three.jpg"), Buffer.alloc(2048));

  assert.ok(dirA.startsWith(s.inboxRoot(agentCwd)), "media lives under the inbox root");
  assert.ok(dirA.includes(a), "media is filed under the conversation's session id");

  assert.deepEqual(await s.mediaConversationIds(s.inboxRoot(agentCwd)), [a, b].sort());
  assert.deepEqual(await s.inboxStats(s.inboxRoot(agentCwd)), { files: 3, bytes: 3548 });

  const removed = await s.forgetConversationMedia(agentCwd, a);
  assert.deepEqual(removed, { files: 2, bytes: 1500 }, "reports what it removed");

  assert.equal(await exists(dirA), false, "this conversation's media is gone");
  assert.deepEqual(
    await s.inboxStats(s.inboxRoot(agentCwd)),
    { files: 1, bytes: 2048 },
    "another conversation's media survives",
  );
});

test("sessions: orphaned media is detected, not silently kept", async () => {
  const s = jiti(path.join(EXT_DIR, "sessions.ts"));
  const base = await mkdtemp(path.join(tmpdir(), "wa-orphan-"));
  const agentCwd = path.join(base, "agent");
  const sessionsRoot = path.join(base, "sessions");
  const projectDir = path.join(sessionsRoot, "--proj--");
  await mkdir(projectDir, { recursive: true });

  const owned = "wa-user-1-aaa111";
  const orphan = "wa-user-2-bbb222";
  const inbox = s.inboxRoot(agentCwd);

  for (const id of [owned, orphan]) {
    await mkdir(path.join(inbox, id), { recursive: true });
    await writeFile(path.join(inbox, id, "x.jpg"), Buffer.alloc(100));
  }
  // A loose file in the root: the pre-<sessionId>/ layout.
  await writeFile(path.join(inbox, "loose.jpg"), Buffer.alloc(50));

  // Only `owned` has a transcript.
  await writeFile(path.join(projectDir, `2026-01-01T00-00-00-000Z_${owned}.jsonl`), "{}");

  const report = await s.orphanedMedia(agentCwd, sessionsRoot);
  assert.deepEqual(report.conversations, [orphan], "only the transcript-less conversation is orphaned");
  assert.equal(report.looseFiles, 1, "loose root files are reported separately");
  assert.equal(report.files, 2, "orphan count is loose file + orphan dir contents");
  assert.equal(report.bytes, 150);

  // Nothing is deleted by looking.
  assert.equal(await exists(path.join(inbox, owned, "x.jpg")), true);
  assert.equal(await exists(path.join(inbox, orphan, "x.jpg")), true);

  // With no sessions root at all, everything is orphaned.
  const empty = await s.orphanedMedia(agentCwd, path.join(base, "nonexistent"));
  assert.deepEqual(empty.conversations.sort(), [owned, orphan].sort());
});

test("doctor: warns when attachments belong to no conversation", async () => {
  const mock = await startMockServer({ messages: [] });
  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tmpdir(), "wa-doctor-no-sessions");

  try {
    const { runDoctor } = await loadDoctor(`http://127.0.0.1:${mock.port}/agent/v1`);
    const options = await doctorDir();

    // A file in the inbox root, plus a directory whose conversation is gone.
    const inbox = path.join(options.agentCwd, ".wa-inbox");
    await mkdir(path.join(inbox, "wa-user-9-999999"), { recursive: true });
    await writeFile(path.join(inbox, "stray.jpg"), Buffer.alloc(2048));
    await writeFile(path.join(inbox, "wa-user-9-999999", "gone.jpg"), Buffer.alloc(1024));

    const report = await runDoctor(options);
    const media = checkFor(report, "media");

    assert.equal(media.status, "warn", "orphaned media is a warning, not a failure");
    assert.match(media.detail, /2 attachment\(s\) \(3\.0 KB\) belong to no conversation/);
    assert.match(media.detail, /1 loose file\(s\) in the inbox root/);
    assert.match(media.detail, /1 directory\/ies with no transcript/);
    assert.match(media.detail, /forget media/, "names the remedy");

    // A clean setup reports ok.
    const clean = await runDoctor(await doctorDir());
    assert.equal(checkFor(clean, "media").status, "ok");
    assert.match(checkFor(clean, "media").detail, /belongs to a conversation/);
  } finally {
    mock.server.close();
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot;
    delete process.env.WA_BASE_URL;
  }
});

// --------------------------------------------------- workspace and persona

test("persona: the workspace lives in pi's agent directory, never the home directory", () => {
  const p = jiti(path.join(EXT_DIR, "persona.ts"));
  const saved = process.env.PI_CODING_AGENT_DIR;

  try {
    delete process.env.PI_CODING_AGENT_DIR;
    const fallback = p.defaultWorkspace();
    assert.equal(fallback, path.join(homedir(), ".pi/agent", "whatsapp"));
    assert.notEqual(
      fallback,
      path.join(homedir(), "whatsapp-agent"),
      "must not be the old standalone-bridge folder in $HOME",
    );
    assert.equal(path.dirname(fallback), p.agentDir(), "sits directly in the agent dir");
    assert.ok(
      !fallback.startsWith(path.join(homedir(), ".pi/agent", "sessions")),
      "not inside sessions/, so clearing history cannot delete the persona",
    );

    process.env.PI_CODING_AGENT_DIR = "/custom/agent";
    assert.equal(p.defaultWorkspace(), path.join("/custom/agent", "whatsapp"), "follows the override");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("persona: seeding happens once and never clobbers the user's work", async () => {
  const p = jiti(path.join(EXT_DIR, "persona.ts"));
  const cwd = path.join(await mkdtemp(path.join(tmpdir(), "wa-persona-")), "whatsapp");

  // First start creates the workspace and seeds the default persona.
  const first = await p.ensureWorkspace(cwd);
  assert.equal(first.seededPersona, true);
  assert.match(await readFile(first.agentsMd, "utf8"), /^# WhatsApp agent/);

  // Second start is a no-op.
  const second = await p.ensureWorkspace(cwd);
  assert.equal(second.seededPersona, false, "idempotent");

  // A user's edits survive.
  await writeFile(first.agentsMd, "# my own agent\n");
  const third = await p.ensureWorkspace(cwd);
  assert.equal(third.seededPersona, false);
  assert.equal(await readFile(first.agentsMd, "utf8"), "# my own agent\n", "edits are preserved");

  // AGENTS.override.md wins, so no AGENTS.md is written beside it.
  const other = path.join(await mkdtemp(path.join(tmpdir(), "wa-persona-")), "whatsapp");
  await mkdir(other, { recursive: true });
  await writeFile(path.join(other, "AGENTS.override.md"), "# override\n");

  const fourth = await p.ensureWorkspace(other);
  assert.equal(fourth.seededPersona, false, "an override suppresses seeding");
  assert.equal(fourth.hasOverride, true);
  assert.equal(await exists(path.join(other, "AGENTS.md")), false, "no redundant AGENTS.md written");

  const state = await p.personaState(other);
  assert.deepEqual(
    { hasAgents: state.hasAgents, hasOverride: state.hasOverride },
    { hasAgents: false, hasOverride: true },
  );
});

test("doctor: reports the persona state for the workspace", async () => {
  const mock = await startMockServer({ messages: [] });
  try {
    const { runDoctor } = await loadDoctor(`http://127.0.0.1:${mock.port}/agent/v1`);

    // Fresh workspace: the default has not been written yet.
    const options = await doctorDir();
    const fresh = await runDoctor(options);
    assert.equal(checkFor(fresh, "persona").status, "warn");

    // After seeding, the check is satisfied.
    const persona = jiti(path.join(EXT_DIR, "persona.ts"));
    await persona.ensureWorkspace(options.agentCwd);
    const seeded = await runDoctor(options);
    assert.equal(checkFor(seeded, "persona").status, "ok");
    assert.match(checkFor(seeded, "persona").detail, /AGENTS\.md present/);

    // An override is reported as taking precedence.
    await writeFile(path.join(options.agentCwd, "AGENTS.override.md"), "# override\n");
    const overridden = await runDoctor(options);
    assert.match(checkFor(overridden, "persona").detail, /AGENTS\.override\.md takes precedence/);
  } finally {
    mock.server.close();
    delete process.env.WA_BASE_URL;
  }
});

test("pi integration: PI_CODING_AGENT_DIR moves the whole footprint together", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-agentdir-"));
  const agentDir = path.join(dir, "agent");
  await mkdir(agentDir, { recursive: true });

  // Token at the default path *inside the overridden agent dir*: nothing tells
  // the extension where to look, so this only works if the paths derive from it.
  await writeFile(path.join(agentDir, "whatsapp-agent.json"), JSON.stringify({ token: "t" }));

  const mock = await startMockServer({ messages: [] });

  // Every WA_* override must be absent for the defaults to be under test.
  const WA_KEYS = ["WA_CONFIG", "WA_STATE", "WA_LOCK", "WA_PI_CWD", "WA_PI_BIN", "WA_BASE_URL"];
  const saved = Object.fromEntries(WA_KEYS.map((k) => [k, process.env[k]]));
  for (const k of WA_KEYS) delete process.env[k];

  const pi = startPi(
    { PI_CODING_AGENT_DIR: agentDir, WA_BASE_URL: `http://127.0.0.1:${mock.port}/agent/v1` },
    // Loaded explicitly on purpose: overriding the agent dir also relocates where
    // pi discovers user extensions (`<agent-dir>/extensions`), so relying on
    // discovery would find nothing and this test would pass for the wrong reason.
    ["--whatsapp", "--extension", path.join(EXT_DIR, "index.ts")],
  );
  const realLock = path.join(homedir(), ".pi/agent/whatsapp-agent.lock");
  const realWorkspace = path.join(homedir(), ".pi/agent/whatsapp");
  const realLockBefore = await exists(realLock);
  const realWorkspaceBefore = await exists(path.join(realWorkspace, "AGENTS.md"));

  try {
    const workspace = path.join(agentDir, "whatsapp");
    await waitFor(
      async () => (await exists(path.join(workspace, "AGENTS.md"))) || null,
      { timeoutMs: 30_000 },
    );

    assert.equal(
      await exists(path.join(workspace, "AGENTS.md")),
      true,
      "workspace and persona follow the agent dir",
    );
    assert.equal(
      await exists(path.join(agentDir, "whatsapp-agent.lock")),
      true,
      "the lock follows the agent dir too",
    );

    // Compared before/after rather than asserted absent: a real listener may be
    // running on this machine and legitimately holding the default lock. What is
    // under test is that THIS run wrote nothing there.
    assert.equal(
      await exists(realLock),
      realLockBefore,
      "this run wrote nothing to the real agent dir",
    );
    assert.equal(
      await exists(path.join(realWorkspace, "AGENTS.md")),
      realWorkspaceBefore,
      "this run created no workspace in the real agent dir",
    );
  } finally {
    await stopPi(pi);
    mock.server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// -------------------------------------------------------------- footer text

const ANSI = /\u001b\[[0-9;]*m/g;

/** Footer text the extension set under its own status key, ANSI-stripped. */
function waStatuses(pi) {
  return pi.records
    .filter(
      (r) =>
        r.type === "extension_ui_request" && r.method === "setStatus" && r.statusKey === "whatsapp",
    )
    .map((r) => String(r.statusText ?? "").replace(ANSI, ""));
}

test("pi integration: the footer stays empty while the extension is off", async () => {
  const f = await fixture([]);

  // No --whatsapp: the extension loads but does not listen.
  const pi = startPi(f.env, []);
  try {
    await waitFor(() => pi.records.some((r) => r.type === "extension_ui_request"), {
      timeoutMs: 20_000,
    });
    await sleep(1000);

    const shown = waStatuses(pi).filter((t) => t !== "");
    assert.deepEqual(
      shown,
      [],
      `the footer must show nothing when off, got ${JSON.stringify(shown)}`,
    );
    assert.equal(f.mock.received.polls, 0, "and it is not polling");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

// -------------------------------------------- audit fixes: security hardening

test("util: unsafe media ids are rejected, not sanitised", () => {
  const { isSafeMediaId } = jiti(path.join(EXT_DIR, "util.ts"));

  for (const id of ["998a7c17-60bf-4f40-a313-85f3723e2104", "abc_123", "a.b-c"]) {
    assert.equal(isSafeMediaId(id), true, `accepts ${id}`);
  }
  for (const id of ["../escaped", "sub/file", "..", ".", "", "a b", "a\\b", "a?b", "a#b", "a%2Fb"]) {
    assert.equal(isSafeMediaId(id), false, `rejects ${JSON.stringify(id)}`);
  }
});

test("client: the bearer token never goes to a response-supplied media host", async () => {
  const savedBase = process.env.WA_BASE_URL;

  // Metadata names a host that is neither the API origin nor the media CDN.
  const mock = await startMockServer({ messages: [], mediaUrl: "https://evil.example/x.jpg" });
  process.env.WA_BASE_URL = `http://127.0.0.1:${mock.port}/agent/v1`;

  try {
    const localJiti = createJiti(path.join(EXT_DIR, "client.ts"), { moduleCache: false });
    const { WhatsAppClient } = localJiti(path.join(EXT_DIR, "client.ts"));
    const client = new WhatsAppClient("secret-token");

    await assert.rejects(
      () => client.fetchMedia("998a7c17-60bf-4f40-a313-85f3723e2104"),
      /host not allowed/,
      "a foreign host is refused before the token is attached",
    );
    assert.equal(mock.received.mediaFetches, 0, "the disallowed host was never contacted");

    // An unsafe id is refused before any request is made at all.
    await assert.rejects(() => client.fetchMedia("../../etc/passwd"), /invalid media id/);
    assert.equal(mock.received.mediaMeta, 1, "no metadata request for a rejected id");
  } finally {
    mock.server.close();
    if (savedBase === undefined) delete process.env.WA_BASE_URL;
    else process.env.WA_BASE_URL = savedBase;
  }
});

test("client: media from the API's own origin is still fetched", async () => {
  const savedBase = process.env.WA_BASE_URL;
  const mock = await startMockServer({ messages: [] });
  process.env.WA_BASE_URL = `http://127.0.0.1:${mock.port}/agent/v1`;

  try {
    const localJiti = createJiti(path.join(EXT_DIR, "client.ts"), { moduleCache: false });
    const { WhatsAppClient } = localJiti(path.join(EXT_DIR, "client.ts"));

    const result = await new WhatsAppClient("t").fetchMedia("998a7c17-60bf-4f40-a313-85f3723e2104");
    assert.equal(result.bytes.length, 3, "same-origin media is allowed through");
    assert.equal(mock.received.mediaFetches, 1);
  } finally {
    mock.server.close();
    if (savedBase === undefined) delete process.env.WA_BASE_URL;
    else process.env.WA_BASE_URL = savedBase;
  }
});

test("util: acquiring the lock leaves no staging file behind", async () => {
  const { acquireLock, releaseLock } = jiti(path.join(EXT_DIR, "util.ts"));
  const dir = await mkdtemp(path.join(tmpdir(), "wa-lock-atomic-"));
  const lockPath = path.join(dir, "x.lock");

  assert.equal((await acquireLock(lockPath, "a")).ok, true);
  assert.equal(await exists(`${lockPath}.tmp`), false, "no shared temp path is used");

  // A second acquire from this process is still reported as held by us, and the
  // exclusive create means a foreign live holder is respected (covered above).
  assert.equal((await acquireLock(lockPath, "b")).ok, true, "same pid may re-acquire");

  await releaseLock(lockPath);
  assert.equal(await exists(lockPath), false);
});

test("pi integration: reconnect after disconnect keeps the new lock and footer", async () => {
  // A failing poll parks the loop in its backoff sleep, which is the window in
  // which a superseded loop's finalizer used to clobber the replacement run.
  const f = await fixture([], {
    updatesError: { status: 500, body: { error: { code: 2, message: "server error" } } },
  });

  const pi = startPi(f.env);
  try {
    await waitFor(async () => (await exists(f.lockPath)) || null, { timeoutMs: 30_000 });
    await sleep(300); // let the loop enter its backoff sleep

    pi.child.stdin.write(`${JSON.stringify({ id: "r1", type: "prompt", message: "/whatsapp disconnect" })}\n`);
    await sleep(300);
    pi.child.stdin.write(`${JSON.stringify({ id: "r2", type: "prompt", message: "/whatsapp connect" })}\n`);
    await sleep(3000); // the stale finalizer would run when its sleep ends

    assert.equal(
      await exists(f.lockPath),
      true,
      "the superseded loop must not release the replacement run's lock",
    );

    // The footer must still describe a live run rather than having been reset to
    // off by the stale finalizer. This mock fails polls, so it reports HTTP 500.
    const footers = waStatuses(pi);
    assert.match(
      footers.at(-1),
      /whatsapp: /,
      `footer must describe the live run, got ${JSON.stringify(footers.slice(-5))}`,
    );
    assert.notEqual(footers.at(-1), "", "the footer was not cleared to off");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

test("pi integration: control characters from an error body cannot reach the footer", async () => {
  const f = await fixture(
    [
      {
        from: "user:50972923564215",
        id: "wamid.in.1",
        timestamp: "1736844652",
        type: "text",
        text: { body: "hi" },
      },
    ],
    // A plain-text body puts the marker at the start of the error text, before
    // the footer's 40-character truncation. 400 is not retryable, so this fails fast.
    { sendError: { status: 400, body: "\u0007\u001b[31mRED boom" } },
  );

  const pi = startPi(f.env);
  try {
    const raw = await waitFor(
      () => {
        const texts = pi.records
          .filter(
            (r) =>
              r.type === "extension_ui_request" &&
              r.method === "setStatus" &&
              r.statusKey === "whatsapp",
          )
          .map((r) => String(r.statusText ?? ""));
        return texts.find((t) => t.includes("boom")) ?? null;
      },
      { timeoutMs: 40_000 },
    );

    assert.ok(!raw.includes("\u0007"), "BEL must be stripped");
    assert.ok(!raw.includes("\u001b[31m"), "injected SGR must be stripped");
    assert.match(raw, /boom/, "the readable part of the message survives");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

test("pi integration: a transient poll failure clears once polls succeed again", async () => {
  // One 500, then healthy polls. `alwaysEmpty` makes the first SUCCESSFUL poll a
  // 204, so the only route back to "connected" is the 204 branch — otherwise the
  // updates branch clears it and this test would pass without the fix.
  const f = await fixture([], {
    updatesError: {
      status: 500,
      body: { error: { code: 2, message: "Internal server error" } },
      times: 1,
    },
    alwaysEmpty: true,
  });

  const pi = startPi(f.env);
  try {
    await waitFor(() => (waStatuses(pi).some((t) => t.includes("HTTP 500")) ? true : null), {
      timeoutMs: 30_000,
    });

    const recovered = await waitFor(
      () => (waStatuses(pi).at(-1) === "whatsapp: connected" ? true : null),
      { timeoutMs: 30_000 },
    );
    assert.ok(recovered, `footer must recover, got ${JSON.stringify(waStatuses(pi).slice(-4))}`);
    assert.ok(f.mock.received.polls > 1, "it kept polling after the failure");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

// ------------------------------------- sending without starting the listener

test("pi integration: a session that is not listening can still send", async () => {
  const f = await fixture([]);

  // A previous run learned the recipient and persisted it.
  await writeFile(f.statePath, JSON.stringify({ next_offset: 7, creator: "user:50972923564215" }));

  // No --whatsapp: this session never polls.
  const pi = startPi(f.env, []);
  try {
    pi.child.stdin.write(`${JSON.stringify({ id: "s1", type: "prompt", message: "/whatsapp send hello from a plain session" })}\n`);

    const send = await waitFor(() => f.mock.received.sends[0], { timeoutMs: 30_000 });
    assert.equal(send.to, "user:50972923564215", "the persisted recipient is used");
    assert.equal(send.text.body, "hello from a plain session");
    assert.equal(f.mock.received.polls, 0, "outbound needs no poller");
    assert.equal(await exists(f.lockPath), false, "and takes no lock");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

test("pi integration: an inbound message persists the recipient for later sessions", async () => {
  const f = await fixture([
    {
      from: "user:50972923564215",
      id: "wamid.in.1",
      timestamp: "1736844652",
      type: "text",
      text: { body: "hi" },
    },
  ]);

  const pi = startPi(f.env);
  try {
    await waitFor(() => f.mock.received.sends[0], { timeoutMs: 30_000 });

    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(state.creator, "user:50972923564215", "the recipient is written to disk");
    assert.equal(typeof state.next_offset, "number", "the offset is preserved alongside it");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

// -------------------------------------- gaps found by the pre-publish review

test("runner: the child pi does not inherit the API token or parent session state", async () => {
  const { runPi } = jiti(path.join(EXT_DIR, "runner.ts"));
  const dir = await mkdtemp(path.join(tmpdir(), "wa-scrub-"));
  const { bin, record } = await writeStub(dir);

  const saved = {
    token: process.env.WHATSAPP_AGENT_TOKEN,
    model: process.env.PI_MODEL,
    session: process.env.PI_SESSION_ID,
  };
  process.env.WHATSAPP_AGENT_TOKEN = "must-not-reach-the-child";
  process.env.PI_MODEL = "must-not-reach-the-child";
  process.env.PI_SESSION_ID = "must-not-reach-the-child";

  try {
    const result = await runPi({
      prompt: "hi",
      sessionId: "wa-scrub",
      name: "wa scrub",
      cwd: dir,
      piBin: bin,
      timeoutMs: 10_000,
    });
    assert.equal(result.ok, true);

    const [invocation] = (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(invocation.env.WHATSAPP_AGENT_TOKEN, null, "the API token must be scrubbed");
    assert.equal(invocation.env.PI_MODEL, null, "parent session metadata must be scrubbed");
    assert.equal(invocation.env.PI_SESSION_ID, null, "the parent session id must be scrubbed");
    assert.equal(invocation.env.WA_INTERNAL_CHILD, "1", "the child is still marked");
  } finally {
    for (const [key, value] of [
      ["WHATSAPP_AGENT_TOKEN", saved.token],
      ["PI_MODEL", saved.model],
      ["PI_SESSION_ID", saved.session],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("util: concurrent acquires admit exactly one holder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-lock-race-"));
  const lockPath = path.join(dir, "race.lock");
  const child = path.join(dir, "child.mjs");

  // Separate processes: in-process callers are all "ours", which is why a
  // same-process test cannot show the race.
  await writeFile(
    child,
    `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createJiti } = require(process.env.JITI);
const util = createJiti(process.env.UTIL)(process.env.UTIL);
const result = await util.acquireLock(process.env.LOCK, process.env.KIND);
process.stdout.write(JSON.stringify({ ok: result.ok }));
// Hold it: a child that exits at once makes its own lock legitimately stale, and a
// later reader would take it over, which would look like two winners.
await new Promise((resolve) => setTimeout(resolve, 3000));
`,
  );

  const runs = await Promise.all(
    [0, 1, 2].map(
      (i) =>
        new Promise((resolve) => {
          const proc = spawn(process.execPath, [child], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              JITI: findJiti(),
              UTIL: path.join(EXT_DIR, "util.ts"),
              LOCK: lockPath,
              KIND: `child-${i}`,
            },
          });
          let out = "";
          proc.stdout.on("data", (d) => (out += d));
          proc.on("close", () => resolve(out));
        }),
    ),
  );

  const winners = runs.filter((out) => out.includes('"ok":true'));
  assert.equal(winners.length, 1, `exactly one process may hold the lock, got ${JSON.stringify(runs)}`);
});

test("pi integration: an image message is filed per conversation, private, and attached", async () => {
  const f = await fixture([
    {
      from: "user:50972923564215",
      id: "wamid.in.1",
      timestamp: "1736844652",
      type: "image",
      image: { id: "998a7c17-60bf-4f40-a313-85f3723e2104", mime_type: "image/jpeg" },
    },
  ]);

  const pi = startPi(f.env);
  try {
    await waitFor(() => f.mock.received.sends[0], { timeoutMs: 30_000 });

    const { sessionIdFor } = jiti(path.join(EXT_DIR, "util.ts"));
    const sessionId = sessionIdFor("user:50972923564215");
    const dir = path.join(f.agentCwd, ".wa-inbox", sessionId);
    const file = path.join(dir, "998a7c17-60bf-4f40-a313-85f3723e2104.jpg");

    const fileStat = await stat(file);
    assert.equal(fileStat.mode & 0o777, 0o600, "the attachment is private");
    assert.equal((await stat(dir)).mode & 0o777, 0o700, "its directory is private");
    assert.equal(fileStat.size, 3, "the downloaded bytes are what landed on disk");

    // The child was handed the file by relative path, with @path last.
    const [invocation] = (await readFile(f.record, "utf8")).trim().split("\n").map(JSON.parse);
    const prompt = invocation.argv.at(-1);
    assert.ok(
      prompt.endsWith(`@.wa-inbox/${sessionId}/998a7c17-60bf-4f40-a313-85f3723e2104.jpg`),
      `@path must be the final token, got ${JSON.stringify(prompt.slice(-90))}`,
    );
    assert.equal(f.mock.received.mediaFetches, 1, "the media bytes were fetched once");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

test("pi integration: an offset-only write preserves the stored recipient", async () => {
  // messages is empty, so handle() never runs and the only write is the offset.
  const f = await fixture([]);
  await writeFile(f.statePath, JSON.stringify({ next_offset: 7, creator: "user:50972923564215" }));

  const pi = startPi(f.env);
  try {
    await waitFor(
      async () => {
        try {
          return JSON.parse(await readFile(f.statePath, "utf8")).next_offset === 5 ? true : null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 30_000 },
    );

    const state = JSON.parse(await readFile(f.statePath, "utf8"));
    assert.equal(state.next_offset, 5, "the offset advanced");
    assert.equal(state.creator, "user:50972923564215", "the recipient survived the write");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

test("pi integration: repeated 409s are reported, keep polling, and do not move the offset", async () => {
  // 409 for the whole window, so no successful poll can write an offset and make
  // the assertion below pass or fail by timing.
  const f = await fixture([], { conflicts: 999 });

  const pi = startPi(f.env);
  try {
    await waitFor(
      () => (waStatuses(pi).some((t) => /another poller/.test(t)) ? true : null),
      { timeoutMs: 40_000 },
    );

    assert.ok(f.mock.received.polls >= 3, "it keeps polling through the conflicts");
    assert.equal(await exists(f.statePath), false, "a conflict must not advance the offset");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});

test("client: sendText retries transient failures and fails fast on permanent ones", async () => {
  const savedBase = process.env.WA_BASE_URL;

  // 500 once, then success: the retry must land the message.
  const flaky = await startMockServer({
    messages: [],
    sendError: { status: 500, body: { error: { code: 2, message: "boom" } }, times: 1 },
  });
  process.env.WA_BASE_URL = `http://127.0.0.1:${flaky.port}/agent/v1`;
  try {
    const localJiti = createJiti(path.join(EXT_DIR, "client.ts"), { moduleCache: false });
    const { WhatsAppClient } = localJiti(path.join(EXT_DIR, "client.ts"));

    const sent = await new WhatsAppClient("t").sendText("user:1", "hi");
    assert.equal(sent.ok, true, "a 500 is retried");
    assert.equal(flaky.received.sends.length, 1, "and delivered exactly once");
  } finally {
    flaky.server.close();
  }

  // 400 is permanent: exactly one attempt, no retry.
  const permanent = await startMockServer({
    messages: [],
    sendError: { status: 400, body: { error: { code: 131005, message: "not the creator" } } },
  });
  process.env.WA_BASE_URL = `http://127.0.0.1:${permanent.port}/agent/v1`;
  try {
    const localJiti = createJiti(path.join(EXT_DIR, "client.ts"), { moduleCache: false });
    const { WhatsAppClient } = localJiti(path.join(EXT_DIR, "client.ts"));

    const sent = await new WhatsAppClient("t").sendText("user:1", "hi");
    assert.equal(sent.ok, false, "a 4xx fails fast");
    assert.match(sent.error, /131005|not the creator/, "the reason is reported");
  } finally {
    permanent.server.close();
    if (savedBase === undefined) delete process.env.WA_BASE_URL;
    else process.env.WA_BASE_URL = savedBase;
  }
});

test("pi integration: with no recipient stored, sending explains what to do", async () => {
  const f = await fixture([]); // no state file: nothing has ever been received

  const pi = startPi(f.env, []);
  try {
    pi.child.stdin.write(`${JSON.stringify({ id: "n1", type: "prompt", message: "/whatsapp send hi" })}\n`);

    const text = await waitFor(
      () => (/No recipient yet/.test(pi.text()) ? pi.text() : null),
      { timeoutMs: 30_000 },
    );
    assert.match(text, /No recipient yet/);
    assert.equal(f.mock.received.sends.length, 0, "nothing is sent");

    // The default subcommand must still report state.
    pi.child.stdin.write(`${JSON.stringify({ id: "n2", type: "prompt", message: "/whatsapp status" })}\n`);
    const status = await waitFor(
      () => (/creator: not yet seen/.test(pi.text()) ? pi.text() : null),
      { timeoutMs: 30_000 },
    );
    assert.match(status, /status: off/, "the default subcommand reports state");
  } finally {
    await stopPi(pi);
    f.mock.server.close();
  }
});
