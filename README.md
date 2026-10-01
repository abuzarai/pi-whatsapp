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

Two tools are available to the model in **every** pi session:

| Tool | What it does |
|---|---|
| `whatsapp_send` | Message you |
| `whatsapp_status` | Report the listener's state |

---

## Sending from any session

You do **not** need to be listening to send. In any ordinary pi session:

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
| `HTTP 400 / code 100` | The key is present but invalid. Regenerate it in WhatsApp |
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
- **Rate limits** per agent: 12 sends/min, 12 read receipts/min, 15 polls/min.
- **One poller per agent** — see above.
- **Messages are capped at 4096 characters**; longer replies are split.

---

## Development

No build step: pi loads the TypeScript directly through jiti. Try a checkout
without installing it, with `pi -e .` from the repo root.

```bash
npm install             # one devDependency (jiti)
npm test                # 46 hermetic tests — mock platform, stub pi, real pi in RPC mode
npm run test:semantics  # 4 tests that spawn real pi with real model calls
npm run test:all        # both
```

The suites run without `npm install` too: they fall back to the jiti bundled inside
pi's own install, and `PI_BIN` / `PI_ROOT` / `PI_JITI_PATH` override the lookup if
pi lives somewhere unusual.

The hermetic suite covers the full inbound → child pi → reply path against a mock
platform, the state file, the lock, media permissions, and error rendering. The
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
| `persona.ts` | Workspace location and the default `AGENTS.md` |
| `runner.ts` | Spawning the child pi |
| `sessions.ts` | Locating and deleting transcripts and attachments |
| `util.ts` | Chunking, session ids, token loading, the lock |

---

## License

[MIT](LICENSE).
