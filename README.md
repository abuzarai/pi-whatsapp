# pi-whatsapp

Message your **pi** agent from WhatsApp, and have it message you back.

```
your phone ──▶ WhatsApp ──▶ Meta's Agent Platform ──▶ this extension ──▶ pi
                                                             │
your phone ◀──────────────── reply ◀──────────────────────────┘
```

This uses Meta's official **[WhatsApp Agent Platform](https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf)**.
You create an agent inside WhatsApp itself, and it appears as a contact in your
chat list. There is no QR-code device linking, no reverse-engineered protocol, and
no risk to your number.

**It is a personal agent.** Only you can message it, and it can only see what you
send it. It cannot read your other chats.

---

## Requirements

- **[pi](https://github.com/earendil-works/pi)** — any recent version
- **Node 20.3+** (already required by pi)
- A WhatsApp account in a country where the Agent Platform has rolled out
- **No API key from Meta.** You get the credential from inside WhatsApp, below

> If **Settings → Agents** does not exist in your WhatsApp, the rollout has not
> reached you yet and this will not work.

---

## Install

```bash
pi install git:github.com/abuzarai/pi-whatsapp@v0.1.0
```

That fetches the repository, installs it, and records it in
`~/.pi/agent/settings.json`. Pinning `@v0.1.0` keeps you on a release; omit it to
track the default branch. Confirm it registered with:

```bash
pi list
```

Or clone it into pi's extensions directory, which needs no settings entry:

```bash
git clone https://github.com/abuzarai/pi-whatsapp.git ~/.pi/agent/extensions/whatsapp
```

Either way there is **no build step** — pi loads the TypeScript directly through
jiti — and **no runtime dependencies**.

To remove a package install, pass the same source:

```bash
pi remove git:github.com/abuzarai/pi-whatsapp
```

---

## Setup

### 1. Create the agent in WhatsApp

On your phone: **Settings → Agents → Create an agent**, and give it a name and
avatar.

Then open that agent's chat → **Chat info → API key** → copy the key.

### 2. Save the key

Create `~/.pi/agent/whatsapp-agent.json` and paste the key in as the `token` value:

```json
{
  "token": "your_api_key_here"
}
```

That file is a credential, so make it readable only by you:

```bash
chmod 600 ~/.pi/agent/whatsapp-agent.json
```

If you would rather not keep it in a file, export `WHATSAPP_AGENT_TOKEN` instead —
it takes precedence over the file.

### 3. Start it and check

```bash
pi --whatsapp
```

Then, inside pi:

```
/whatsapp doctor
```

You want eight ticks:

```
✓ token: Found in ~/.pi/agent/whatsapp-agent.json (48 chars)
✓ api: https://api.whatsapp.com/agent/v1 reachable, token accepted
✓ lock: Free — no other poller
✓ pi: 0.99.2 (tools: read,grep,find,ls)
✓ workspace: Writable: ~/.pi/agent/whatsapp
✓ persona: AGENTS.md present in ~/.pi/agent/whatsapp
✓ offset: First run: starts at the head, so the 30-day backlog is skipped
✓ media: Every attachment belongs to a conversation
```

### 4. Message it from your phone

Send your agent `hello`. Within about 25 seconds you get a reply.

**Do this before trying to send anything from pi.** The extension learns *who* to
send to from the first message it receives — until then it has no recipient, and
sending will tell you so.

---

## Commands and tools

| Command | What it does |
|---|---|
| `/whatsapp` | Status: state, counters, recipient, attachments |
| `/whatsapp doctor` | Diagnose the setup |
| `/whatsapp connect` | Start listening in this session |
| `/whatsapp disconnect` | Stop listening |
| `/whatsapp send <text>` | Send literal text to your WhatsApp |
| `/whatsapp forget` | Forget this conversation — transcript and attachments |
| `/whatsapp forget all` | Forget every WhatsApp conversation |
| `/whatsapp forget media` | Delete every downloaded attachment |

Three tools are registered when the extension loads. They are available to the
model only when that session's tool allowlist includes them:

| Tool | What it does |
|---|---|
| `whatsapp_send` | Message you |
| `whatsapp_send_file` | Send a local file to you |
| `whatsapp_status` | Report the listener's state |

---

## Sending from any session

You do **not** need to be listening to send. In an ordinary pi session with the
extension enabled and its send tool allowed:

```
whatsapp me these details concisely
```

pi composes the message and sends it. This works because the recipient is
remembered on disk, not in the session.

Also useful:

```
Run the full test suite, then WhatsApp me the summary and any failures.
```

Use plain language for that — pi writes the message. `/whatsapp send <text>` is a
command that sends your text **verbatim**, so it does not summarise anything.

## Sending files back

Ask pi to send a local file:

```
Send ./reports/summary.pdf to my WhatsApp with the caption "Test results".
```

The `whatsapp_send_file` tool uploads the bytes, then sends a message using the
returned media ID. It sends only to the remembered creator. Paths can be absolute
or relative to the invoking session's working directory, not necessarily
`WA_PI_CWD`. Regular files and symlinks to regular files are supported; directories
and special files are rejected. Nothing from the inbox is automatically forwarded.

| Kind | Supported formats | Local size cap |
|---|---|---|
| Image | JPEG, PNG | 5,000,000 bytes (5 MB) |
| Video | MP4, 3GPP | 16,000,000 bytes (16 MB) |
| Audio | AAC, m4a, MP3, AMR-NB, Opus-in-Ogg, .opus | 16,000,000 bytes (16 MB) |
| Document | PDF, TXT, doc/docx, xls/xlsx, ppt/pptx; unknown extensions as generic binary | 16,000,000 bytes (16 MB) |
| Sticker | WebP | 500,000 bytes (500 KB) |

We use conservative decimal caps because the manual does not define MB/KB byte
multipliers. We check size and bound the read before uploading. A file extension
selects the upload type; a document display rename does not change it. `.opus`
uploads use `audio/opus`. Unknown extensions use `application/octet-stream`, not
an unsupported declared MIME type.

Images must be 8-bit RGB/RGBA and at most 25 megapixels. Video must use H.264 and
AAC; Ogg audio must contain mono Opus. Stickers must fit within 4096×4096 pixels.
The extension does not transcode or inspect these profiles; WhatsApp can reject
an incorrectly encoded file even when it fits the size cap.

Captions are allowed only on images, videos and documents, up to 1024 characters.
The tool schema limits input; direct client calls cap captions without splitting
Unicode characters. `filename` is a document-only display name, including its
extension. It defaults to the original basename. If the source document has an
extension, an explicit rename must also include an extension; `report.pdf` cannot
be renamed to just `report`. Genuinely extensionless generic files may keep an
extensionless display name. Empty names, path separators and control characters
are rejected. Unsupported caption/filename options fail before upload rather
than being silently dropped.

### Sending from the phone agent

Default phone children have only `read,grep,find,ls`; registering the tool does
not enable it there. To opt in, start the listener with:

```bash
WA_PI_TOOLS="read,grep,find,ls,whatsapp_send_file" pi --whatsapp
```

Keep the extension enabled in the child's agent directory and save a usable token
in `whatsapp-agent.json` (or `WA_CONFIG`). The parent deliberately removes
`WHATSAPP_AGENT_TOKEN` from child environments. An environment-only setup can
receive messages and send final text through the parent, but cannot authenticate
the child's file tool. Adding the tool to the allowlist does not restore that
token. This opt-in was checked against Pi 1.0.0; other versions may differ.

Giving the phone agent this tool lets it upload files it can read. Removing the
environment token is not a filesystem sandbox: same-user children can still read
accessible config files. The default tool list and credential stripping remain
unchanged. A successful file send does not suppress the normal final text reply.

### Retries and failures

WhatsApp has separate rolling 60-second counters of 12 requests for messages,
statuses and each media method. We retry transient failures with backoff, but
have no local queue; retries can exhaust before the window resets.

A timeout, connection reset or server error can leave delivery unknown. A retry
can send a duplicate. Message retries reuse the uploaded ID, not a fresh upload.
Upload or send failures are reported separately. Unused uploads are not deleted
automatically; the platform documents 30-day expiry.

Upload cancellation interrupts its retry wait. Message retry waits retain the
existing text-send behavior and are not immediately interruptible. A cancelled
upload never proceeds to sending. Success means the message API accepted the
request, not that the recipient received or could open it. Real arrival and
playability still need a separate live check.

## Listening

Receiving is opt-in, per session:

```bash
pi --whatsapp          # or run /whatsapp connect later
```

It is deliberately not automatic: every session would race for the same
single-poller lock, and so would the child pi sessions this extension spawns.

Each WhatsApp conversation runs in its **own child pi session**, so your phone
chats never mix into your terminal work. The agent's working directory is
`~/.pi/agent/whatsapp/`, and it reads its personality from `AGENTS.md` there.

---

## Configuration

Everything is optional except the token. Set these as environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `WHATSAPP_AGENT_TOKEN` | — | Overrides the token file |
| `WA_PI_CWD` | `~/.pi/agent/whatsapp` | The child agent's working directory, persona, and session group |
| `WA_PI_TOOLS` | `read,grep,find,ls` | Which tools the agent may use |
| `WA_PI_MODEL` | pi default | Model for the agent, e.g. `anthropic/claude-sonnet-4-5:high` |
| `WA_PI_TIMEOUT_MS` | `900000` | Kill a child run after this long |
| `WA_PI_BIN` | `pi` | Path to the pi binary |
| `WA_CONFIG` | `~/.pi/agent/whatsapp-agent.json` | Token file |
| `WA_STATE` | `~/.pi/agent/whatsapp-agent-state.json` | Offset and recipient |
| `WA_LOCK` | `~/.pi/agent/whatsapp-agent.lock` | Single-poller lock |
| `WA_BASE_URL` | the real API | Override for testing |

The agent is **read-only by default** — it can read and search, but not modify
anything. That is deliberate, because it is reachable from a phone. To let it
make changes:

```bash
WA_PI_TOOLS="read,edit,write,grep,find,ls,bash" pi --whatsapp
```

### Giving it a personality

On first start the extension writes a default persona to
`~/.pi/agent/whatsapp/AGENTS.md`. Edit it freely — it is never overwritten. To
replace it without touching that file, write `~/.pi/agent/whatsapp/AGENTS.override.md`,
which pi treats as taking precedence.

---

## Storage and privacy

| Where | What | Lifetime |
|---|---|---|
| Meta's servers | Messages, receipts, media | 30 days |
| `~/.pi/agent/whatsapp-agent.json` | Your API token | Until deleted |
| `~/.pi/agent/whatsapp-agent-state.json` | Poll offset + recipient id | Persists |
| `~/.pi/agent/whatsapp-agent.lock` | Single-poller lock | Removed on shutdown |
| `~/.pi/agent/whatsapp/AGENTS.md` | The agent's persona | Until deleted |
| `~/.pi/agent/whatsapp/.wa-inbox/<conversation>/` | Attachments you sent | Until you forget that conversation |

**Conversations are not end-to-end encrypted.** Meta relays them, which is how the
Agent Platform works. Treat it accordingly.

Transcripts are stored **in plain text** by pi, under
`~/.pi/agent/sessions/--<escaped-agent-dir>--/`, one file per conversation. Use
`/whatsapp forget` to delete one, and note that this wipes the *agent's* memory —
your own WhatsApp chat history on your phone is untouched and cannot be deleted
through this API.

---

## Running it headless

To answer messages with no pi session open, run the listener as a service. A
ready-to-copy unit ships in this repo:

```bash
cp whatsapp-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-agent
journalctl --user -u whatsapp-agent -f
loginctl enable-linger $USER     # keep it running while logged out
```

Edit `ExecStart` first: replace the pi path with the output of `command -v pi`.

> **Only one poller may run per agent.** This service and an interactive
> `pi --whatsapp` cannot both listen; the second one refuses and says so.

---

## Troubleshooting

Start with `/whatsapp doctor`.

| Symptom | Cause |
|---|---|
| Footer shows nothing | Not listening. Start with `pi --whatsapp` or `/whatsapp connect` |
| `whatsapp: another poller is running` | Another session or the service holds the lock |
| `No recipient yet` | Nothing has been received yet — message the agent from your phone |
| `HTTP 400 / code 100` | Check the token, media ID or text/caption length; the code is not token-specific |
| Upload fails with `400 / 131053` | Size, MIME type or media format rejected |
| File send fails with `400 / 131009` | Unknown/expired media ID or invalid media fields/type/size |
| `HTTP 401 / code 190` | The `Authorization` header was rejected |
| Sending fails with `403 / 131005` | The recipient is not the agent's creator |
| Nothing arrives at all | Check **Settings → Agents** exists; you may be outside the rollout |
| Images arrive but are not described | Check `WA_PI_TOOLS` includes `read` |

The footer is empty when idle, `whatsapp: connected` while listening, and shows a
short reason if something is wrong.

---

## Limitations

- **Only you can talk to it.** Enforced by Meta, not by this extension.
- **Not end-to-end encrypted.**
- **Up to 5 agents** per WhatsApp account.
- **Audio is not transcribed.** The agent is told it cannot hear voice notes.
- **Rate limits** per agent: 12 sends/min, 12 read receipts/min, 12 requests/min for each media method, 15 polls/min.
- **One poller per agent** — see above.
- **Messages are capped at 4096 characters**; longer replies are split.

---

## Development

No build step: pi loads the TypeScript directly through jiti. Try a checkout
without installing it, with `pi -e .` from the repo root.

```bash
npm install             # one devDependency (jiti)
npm test                # hermetic tests — mock platform, direct tools, stub pi, real pi in RPC mode
npm run test:semantics  # 4 tests that spawn real pi with real model calls
npm run test:all        # both
```

The suites run without `npm install` too: they fall back to the jiti bundled inside
pi's own install, and `PI_BIN` / `PI_ROOT` / `PI_JITI_PATH` override the lookup if
pi lives somewhere unusual.

The hermetic suite covers the full inbound → child pi → reply path against a mock
platform, outbound multipart uploads and registered file-tool callbacks, child
tool opt-in, the state file, the lock, media permissions, and error rendering. The
semantics suite exists because some bugs are invisible to mocks: a stub `pi`
accepts any arguments, so only the real binary can verify that `@path` attachment
parsing works. It skips itself when no model is authenticated.

Architecture, in one line each:

| File | Responsibility |
|---|---|
| `index.ts` | Extension wiring: lifecycle, commands, tools, footer |
| `client.ts` | WhatsApp Agent Platform HTTP client |
| `doctor.ts` | The `/whatsapp doctor` checks |
| `media.ts` | Building the child prompt for an attachment |
| `outbound-media.ts` | Outbound type/option policy and bounded local file reads |
| `persona.ts` | Workspace location and the default `AGENTS.md` |
| `runner.ts` | Spawning the child pi |
| `sessions.ts` | Locating and deleting transcripts and attachments |
| `util.ts` | Chunking, session ids, token loading, the lock |

---

## License

[MIT](LICENSE).
