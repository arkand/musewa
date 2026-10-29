# Muse WhatsApp Bridge

A small standalone bridge that connects one WhatsApp number to an
OpenAI-compatible Muse agent. Text only. DMs need an allowlist entry. Groups
need a mention and an allowlisted member.

## Requirements

- Bun 1.4+
- A dedicated WhatsApp number on a spare phone
- A local OpenAI-compatible Muse API

## Build

```sh
bun install
bun run build
bun test
```

## Install on the VM

```sh
sudo useradd --system --home /var/lib/muse-whatsapp --shell /usr/sbin/nologin muse-whatsapp
sudo install -d -o muse-whatsapp -g muse-whatsapp -m 0700 /var/lib/muse-whatsapp
sudo install -d -o muse-whatsapp -g muse-whatsapp /opt/muse-whatsapp
sudo cp -r dist package.json node_modules /opt/muse-whatsapp/
sudo install -m 0600 /dev/null /etc/muse-whatsapp.env
sudo cp deploy/muse-whatsapp.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Fill `/etc/muse-whatsapp.env` from `.env.example`, then pair:

```sh
sudo systemctl stop muse-whatsapp
cd /opt/muse-whatsapp
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/pair.js --phone +62...
sudo systemctl enable --now muse-whatsapp
```

## Allowlist

```sh
cd /opt/muse-whatsapp
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js dm add +628123
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group add 120363...@g.us
sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env dist/allow.js group member add 120363...@g.us +628123
```

The allowlist reloads on file change without a restart.

## Logs

```sh
journalctl -u muse-whatsapp -f
```

## Notes

- Baileys is unofficial. Keep message volume low and use a number you can lose.
- A `loggedOut` disconnect needs a new pairing.
- Group history is shared by all members.
