# Muse WhatsApp Bridge — Design

Date: 2026-10-29
Status: Approved design, pending spec review

## Problem

Muse is an external AI agent with an OpenAI-compatible HTTP API. The operator
wants to link a dedicated WhatsApp number to Muse so friends can add the number
as a contact and chat with Muse from WhatsApp.

The existing Nakama WhatsApp worker cannot be copied alone. It is a Nakama
server client: it needs `NAKAMA_SERVER_URL`, a local auth token, a shared
`NAKAMA_CONFIG_DIR`, PM2 supervision, and Nakama sessions. This project is a
standalone bridge instead.

## Goals

- Link one WhatsApp account to Muse through a headless pairing code.
- Answer direct messages from allowlisted numbers.
- Answer group messages only on mention, from allowlisted members.
- Keep one Muse conversation per WhatsApp DM contact and one per group.
- Run on the Muse VM with systemd and Bun.
- Keep WhatsApp credentials and API keys private.
- Reuse the proven Baileys transport code from Nakama under the MIT license.

## Non-goals

- Media, voice notes, images, or document handling. Text only in v1.
- A web dashboard, multi-tenant support, or multiple WhatsApp accounts.
- WhatsApp Business Cloud API or other official providers.
- Nakama server, Nakama profiles, artifacts, memory, or automations.
- Pairing codes for friends. Access is controlled by an allowlist file.

## Decisions

| Topic | Decision |
|---|---|
| Muse API | Local OpenAI-compatible API on the same VM |
| WhatsApp link | Baileys linked device with a CLI pairing code |
| Scope | Text-only DMs and groups with mention handling |
| Access | Deny by default; allowlist file with hot reload |
| Project location | `/home/arkan/projects/muse-whatsapp-bridge` |
| Deployment | systemd service with Bun |
| Code reuse | Port Nakama transport modules; replace the Nakama client |

## Architecture

```
src/
  index.ts                 start bridge, load config, connect
  config.ts                env + file config (zod)
  whatsapp/
    socket.ts              Baileys connect/reconnect (adapted)
    auth-state.ts          multi-file auth, 0700 perms (adapted)
    inbound-message.ts     text extraction, echo suppression, JIDs (adapted)
    group-message.ts       mention and group rules (adapted)
    format.ts              WhatsApp-safe formatting, split (adapted)
    log-metadata.ts        JID masking (adapted)
  muse/
    client.ts              OpenAI-compatible chat client
    history.ts             per-conversation history, capped
  access/allowlist.ts      allowed numbers + group policy, hot reload
  bridge/handler.ts        gate -> history -> Muse -> reply
  cli/pair.ts              headless pairing code
  cli/allow.ts             add/remove allowed numbers
  store/json-store.ts      atomic JSON writes
deploy/muse-whatsapp.service
.env.example
README.md
LICENSE.nakama
```

### Component responsibilities

- **socket**: own the Baileys connection, reconnect with exponential backoff,
  report inbound text messages, and send replies.
- **auth-state**: store Baileys credentials under `STATE_DIR/auth` with private
  permissions.
- **inbound-message**: extract text, sender and chat JIDs, mentions, and the
  message ID. Track recent outbound messages to suppress echoes.
- **group-message**: decide if a group message addresses the bot. A mention of
  the bot number or a reply to a bot message counts. A plain group message does
  not.
- **format**: convert Markdown to WhatsApp-safe text and split long replies.
- **handler**: apply the policy gate, deduplicate, lock the chat, send a typing
  indicator, update history, call Muse, and send the reply.
- **muse client**: call `POST {MUSE_BASE_URL}/chat/completions` with the model
  and message list. Use a request timeout and map failures to short user
  messages.
- **history**: keep a capped message list per conversation and persist it.
- **allowlist**: load and validate `allowlist.json`, reload on file change,
  keep the last good copy on parse errors.
- **CLI**: pair the number and edit the allowlist on the VM.

## Configuration

Env file: `/etc/muse-whatsapp.env`, mode `0600`.

```
MUSE_BASE_URL=http://127.0.0.1:PORT/v1
MUSE_API_KEY=
MUSE_MODEL=
MUSE_SYSTEM_PROMPT_FILE=/etc/muse-persona.md
STATE_DIR=/var/lib/muse-whatsapp
WHATSAPP_PHONE_NUMBER=+62...
GROUP_REQUIRE_MENTION=true
HISTORY_MAX_TURNS=20
REQUEST_TIMEOUT_MS=120000
```

Rules:

- `MUSE_BASE_URL` is required and must not end with a slash.
- `MUSE_API_KEY` is optional. When present, send it as a Bearer token.
- `MUSE_MODEL` is required.
- `MUSE_SYSTEM_PROMPT_FILE` is optional. When set, the file must exist and its
  contents are prepended as the first `system` message. A missing file is a
  startup error.
- `STATE_DIR` defaults to `/var/lib/muse-whatsapp`.
- `GROUP_REQUIRE_MENTION` defaults to `true`.
- `HISTORY_MAX_TURNS` defaults to `20` turns (40 messages).
- `REQUEST_TIMEOUT_MS` defaults to `120000`.

All values are validated with zod at startup. The process exits with a clear
message when a required value is missing.

## State

`STATE_DIR` mode `0700`:

- `auth/`: Baileys credentials, mode `0700`.
- `history.json`: conversation history, atomic writes.
- `allowlist.json`: access policy, hot-reloaded.

### Allowlist format

```json
{
  "dm": ["628123@s.whatsapp.net"],
  "groups": {
    "12036...@g.us": {
      "allowAll": false,
      "members": ["628123@s.whatsapp.net"]
    }
  }
}
```

- Phone numbers are normalized to WhatsApp JIDs (`<digits>@s.whatsapp.net`).
- A stored LID JID (`<digits>@lid`) is also accepted, because WhatsApp may
  address a member by LID.
- An empty or missing `dm` list denies all direct messages.
- A group is denied when it is absent from `groups`.
- `allowAll` defaults to `false`.
- `allowAll: true` permits every member of that group. Use it only for trusted
  groups.
- When `allowAll` is false, only listed `members` are answered.
- The CLI normalizes input such as `+628123` to the stored JID form.
- The policy checks every sender identity (PN and LID) and accepts the message
  when any identity matches.

## Message flow

1. Baileys receives a message.
2. Extract text, sender JID, chat JID, mention information, message ID, and the
   `fromMe` flag.
3. Drop own echoes, empty text, and every non-text message.
4. Policy gate:
   - Direct message: at least one sender identity (PN or LID) must be in `dm`.
   - Group: `GROUP_REQUIRE_MENTION` must be satisfied, the group must be
     configured, and at least one sender identity must pass the group member
     rule.
   - A mention means a mention of the bot number or the bot LID, or a reply to a
     bot message.
5. Deduplicate by message ID with a 2-minute TTL.
6. Acquire a lock for the conversation. Skip if a reply is already running for
   that conversation.
7. Send a typing indicator.
8. Append the user turn to the conversation history. For a group turn, prefix
   the content with `[sender: +<number>]`.
9. Call Muse with the optional system prompt and the conversation history.
10. On success, append the assistant turn, split the reply, and send each part.
11. On failure, send one short error message. Do not append an assistant turn.
12. Release the lock and stop the typing indicator.

### Conversation keys

- Direct message: the sender JID.
- Group: the group JID. All members share the group history.
- History is pruned to `HISTORY_MAX_TURNS` and conversations older than 30 days
  are removed.

### Concurrency

- One active Muse call per conversation.
- At most four active Muse calls across the process. Extra conversations wait.

## Muse client contract

Request:

```
POST {MUSE_BASE_URL}/chat/completions
Authorization: Bearer <key>        # only when MUSE_API_KEY is set
Content-Type: application/json

{
  "model": "<MUSE_MODEL>",
  "messages": [
    { "role": "system", "content": "<optional persona>" },
    { "role": "user", "content": "Hello" }
  ],
  "stream": false
}
```

Response: read `choices[0].message.content`. Treat an empty or missing content
as a failure.

Error handling:

- Timeout or network error: log the cause, reply `Muse is not available right
  now. Please try again.`
- Non-2xx response: log the status and a truncated body, reply with the same
  message.
- Invalid response shape: log the payload shape without message text, reply with
  the same message.

## Error handling

- Baileys disconnect: reconnect with exponential backoff from 1 second to 60
  seconds, with jitter.
- `loggedOut`: stop reconnecting. Exit cleanly and let systemd leave the
  service stopped until the operator pairs again.
- Bad `allowlist.json`: keep the last good copy, log the error, continue.
- History write failure: log and continue with in-memory history.
- Unhandled startup error: log and exit non-zero so systemd restarts the
  service.

## Security

- Deny by default. Unknown senders get no reply.
- Env file `0600`; `STATE_DIR` and `auth/` `0700`.
- The service runs as a dedicated `muse-whatsapp` user.
- Do not log message text by default. Log JIDs only in masked form.
- Inbound text cap: 16 KiB. Longer messages are truncated before the Muse call.
- Per-sender rate limit: 20 messages per minute. Excess messages are dropped
  silently.
- The pairing code is printed only to the VM terminal and is short-lived.

## Deployment

Systemd unit `deploy/muse-whatsapp.service`:

- `User=muse-whatsapp`
- `WorkingDirectory=/opt/muse-whatsapp`
- `EnvironmentFile=/etc/muse-whatsapp.env`
- `StateDirectory=muse-whatsapp`, `StateDirectoryMode=0700`
- `ExecStart=/usr/local/bin/bun /opt/muse-whatsapp/dist/index.js`
- `Restart=on-failure`, `RestartSec=5`, with a start limit so a crash loop stops.
- `NoNewPrivileges=true`, `ProtectSystem=strict`, `PrivateTmp=true`
- Writable paths limited to the state directory.

Build and install:

The `build` script runs three commands:

```sh
bun build src/index.ts --outdir dist --target bun --external @whiskeysockets/baileys
bun build src/cli/pair.ts --outdir dist --target bun --external @whiskeysockets/baileys
bun build src/cli/allow.ts --outdir dist --target bun --external @whiskeysockets/baileys
```

`@whiskeysockets/baileys` stays external, so the deployed directory needs
`node_modules`.

```sh
bun install
bun run build
sudo install -d -o muse-whatsapp -g muse-whatsapp -m 0700 /var/lib/muse-whatsapp
sudo install -d -o muse-whatsapp -g muse-whatsapp /opt/muse-whatsapp
sudo cp -r dist package.json node_modules /opt/muse-whatsapp/
sudo cp deploy/muse-whatsapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now muse-whatsapp
```

Pairing:

```sh
sudo systemctl stop muse-whatsapp
cd /opt/muse-whatsapp
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/pair.js --phone +62...
sudo systemctl start muse-whatsapp
```

Allowlist:

```sh
cd /opt/muse-whatsapp
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js dm add +628123
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js dm remove +628123
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group add 12036...@g.us
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group remove 12036...@g.us
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group member add 12036...@g.us +628123
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group member remove 12036...@g.us +628123
```

Logs: `journalctl -u muse-whatsapp -f`.

## Testing

- Unit tests: allowlist gate, mention detection, reply splitting, history cap,
  Muse error mapping, config validation.
- Integration test: start a fake OpenAI-compatible server with `Bun.serve`, feed
  fake inbound events into the handler, assert outbound content.
- Manual smoke test: pair a test number, then check an allowed DM, a blocked DM,
  a group mention, and a group message without a mention.
- Commands: `bun test`, `bun x tsc --noEmit`, `bun x ultracite check`.
- The project adds `ultracite` as a dev dependency so the lint command works
  from a fresh checkout.

## Reuse and attribution

The adapted files come from the Nakama repository (`apps/platform/whatsapp/`),
which is MIT licensed. Each adapted file keeps a short header credit and the
repository includes `LICENSE.nakama` with the original MIT notice. Files that
are rewritten from scratch do not need the notice.

## Risks

- Baileys is unofficial. WhatsApp can change its protocol or ban the number.
  Use a dedicated number and keep message volume low.
- A banned number needs a new SIM and a new pairing.
- The bridge must stay online to receive messages. systemd restarts it, but a
  `loggedOut` state needs manual pairing.
- Group history is shared by all members. Do not use the bridge in groups where
  shared context is unacceptable.

## Out of scope

- Images, documents, audio, stickers, and reactions.
- Read receipts and presence beyond typing.
- Slash commands and admin commands through WhatsApp.
- Multiple numbers, multiple models, or per-contact model selection.
- A web UI for the allowlist.
