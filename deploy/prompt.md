Setup lengkap "WhatsApp Bridge + Muse" di VPS ini (Linux + systemd),
end-to-end dalam satu sesi. Target: VPS biasa yang punya systemd — BUKAN
VM Muse. (Untuk VM Muse yang read-only tanpa systemd, pakai
`deploy/muse-setup.sh` + respawn loop, bukan runbook ini.)

Asumsi: Bun 1.4+ sudah terpasang di `/usr/local/bin/bun` dan Muse sudah
punya SATU endpoint OpenAI-compatible yang jalan (ini yang dipakai sebagai
`MUSE_BASE_URL`). Jangan tampilkan secret apa pun di output.

1. Deploy bridge.py (file terlampir, v5.1) sebagai systemd service
   (bind 127.0.0.1:8765, antrean file):
   - Taruh `bridge.py` di `/opt/muse-bridge/bridge.py`.
   - Buat service `muse-bridge.service` yang menjalankan
     `python3 /opt/muse-bridge/bridge.py serve` dengan env
     `BRIDGE_QUEUE=/var/lib/muse-bridge/queue` dan
     `BRIDGE_KEYS=/var/lib/muse-bridge/keys.json`.
   - Generate key: `python3 /opt/muse-bridge/bridge.py keygen --role user --label whatsapp`
     dan `... keygen --role worker --label muse-vm` (tiap key dicetak SEKALI).
   - Verifikasi:
       curl -s http://127.0.0.1:8765/health
       curl -s -H "Authorization: Bearer <USER_KEY>" http://127.0.0.1:8765/v1/models
     ( /v1/models WAJIB pakai user key — tanpa key balas 401, itu normal. )

2. Deploy WhatsApp bridge (repo ini) sebagai systemd service kedua.
   Bridge ini klien Baileys (outbound) — TIDAK membuka port HTTP apa pun;
   supervisi lewat systemd, status lewat journalctl.
   - Clone/pull repo, lalu `bun install` dan `bun run build`
     (hasil: dist/index.js, dist/pair.js, dist/allow.js).
   - Install ke `/opt/muse-whatsapp`, pasang
     `deploy/muse-whatsapp.service` ke `/etc/systemd/system/`,
     EnvironmentFile `/etc/muse-whatsapp.env` (mode 600), StateDir
     `/var/lib/muse-whatsapp` (0700).
   - Set `.env`: `MUSE_BASE_URL=http://127.0.0.1:8765/v1`,
     `MUSE_MODEL=muse`, dan `MUSE_API_KEY=<USER_KEY>` dari langkah 1.
   - JANGAN start dulu: index.js akan exit (code 0) selama belum paired.

3. Backup semua key (bridge user key, bridge worker key) ke file
   terpisah permission 600 — jangan pernah tampilkan nilainya di chat.

4. Pasang worker: scheduled task tiap 1 menit (poll /muse/pending, jawab sebagai
   Muse, POST /muse/answer; diam kecuali bridge tak terjangkau / error auth)
   + hook 10 detik yang memantau folder antrean dan langsung membangunkan worker
   begitu ada job baru. Worker pakai WORKER_KEY (role=worker).

5. Pairing + allowlist (WAJIB sebelum bridge WhatsApp bisa membalas):
   - Pair nomor (cetak kode 8 karakter, lalu Perangkat Tertaut di HP):
       sudo systemctl stop muse-whatsapp
       sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env \
         /opt/muse-whatsapp/dist/pair.js --phone +62...
   - Izinkan nomor yang boleh chat (deny-by-default):
       sudo -u muse-whatsapp bun --env-file /etc/muse-whatsapp.env \
         /opt/muse-whatsapp/dist/allow.js dm add +62<nomor-kamu>

6. Jalankan WhatsApp bridge:
       sudo systemctl enable --now muse-whatsapp
       journalctl -u muse-whatsapp -f
   Bridge WhatsApp sudah menunjuk http://127.0.0.1:8765/v1 model "muse"
   (lewat .env di langkah 2).

Laporkan ringkas: lokasi service/config/backup (path unit systemd, .env,
keys backup, queue dir), tanpa menampilkan secret apa pun.
