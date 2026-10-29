#!/usr/bin/env bash
# ===========================================================================
#  muse-setup.sh — pasang Muse WhatsApp Bridge di dalam VM Muse
# ===========================================================================
#  Cara pakai (dari dalam terminal Muse):
#      MUSE_BASE_URL=http://127.0.0.1:8080/v1 MUSE_MODEL=nama-model bash muse-setup.sh
#  atau set dulu env-nya lalu:
#      bash muse-setup.sh
#
#  Yang dilakuin:
#    1. Semua ditaruh di folder PERSISTEN (/home/hatch/pdata) — rootfs Muse
#       read-only & dibangun ulang tiap boot.
#    2. Pasang Bun (runtime bridge) ke dalam folder persisten.
#    3. Ambil/perbarui kode bridge, install dependensi produksi, build.
#    4. Tulis .env dari input kamu (TIDAK pasang gateway/penyedia model apa pun).
#    5. Bikin launcher + respawn loop (Muse nggak punya systemd).
#
#  PENTING: script ini hanya memasang BRIDGE-nya, bukan penyedia model. Bridge
#  butuh SATU endpoint OpenAI-compatible yang sudah jalan (MUSE_BASE_URL). Itu bisa:
#    - API lokal milik Muse sendiri, atau
#    - endpoint OpenAI-compatible lain yang kamu kelola.
#
#  Aman dijalankan berulang: bagian yang sudah ada akan di-skip.
# ===========================================================================
set -uo pipefail

# --------------------------------------------------------------- konfigurasi
PERSIST="${PERSIST:-$HOME/pdata}"          # SATU-SATUNYA folder yang awet di Muse
BUN_DIR="$PERSIST/.bun"                     # instalasi Bun
APP_DIR="$PERSIST/muse-whatsapp-bridge"     # checkout + build bridge
STATE_DIR_DEFAULT="$PERSIST/state"          # STATE_DIR bridge (auth, history, allowlist)
ENVF="$APP_DIR/.env"
REPO_URL="${REPO_URL:-https://github.com/arkand/musewa.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"

# --- yang WAJIB kamu isi (atau pakai default) ------------------------------
MUSE_BASE_URL="${MUSE_BASE_URL:-http://127.0.0.1:8080/v1}"
MUSE_MODEL="${MUSE_MODEL:-}"
MUSE_API_KEY="${MUSE_API_KEY:-}"
MUSE_SYSTEM_PROMPT_FILE="${MUSE_SYSTEM_PROMPT_FILE:-}"
WHATSAPP_PHONE_NUMBER="${WHATSAPP_PHONE_NUMBER:-}"
GROUP_REQUIRE_MENTION="${GROUP_REQUIRE_MENTION:-true}"
HISTORY_MAX_TURNS="${HISTORY_MAX_TURNS:-20}"
REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-120000}"
STATE_DIR="${STATE_DIR:-$STATE_DIR_DEFAULT}"

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_0" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_0" "$*"; }
step() { printf '\n%s── %s ──%s\n' "$C_DIM" "$*" "$C_0"; }
die()  { err "$*"; exit 1; }

step "0. Cek lingkungan"

[ "$(id -u)" = "0" ] || warn "bukan root — kalau ada langkah gagal, ulangi pakai: sudo bash $0"

# Muse nggak punya systemd. Kita pakai respawn loop sendiri.
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  ok "systemd terdeteksi (tetap pakai respawn loop agar seragam di Muse)"
else
  warn "systemd TIDAK ada (normal di Muse) — pakai respawn loop sendiri"
fi

# Proxy: Muse memaksa egress lewat HTTPS_PROXY. localhost harus DIKECUALIKAN,
# kalau tidak bridge->Muse API malah lewat proxy dan bisa kena Sentinel.
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
if [ -n "${HTTPS_PROXY:-}" ]; then
  ok "proxy egress terdeteksi (kredensial tidak ditampilkan)"
else
  warn "HTTPS_PROXY kosong — kalau download gagal, itu sebabnya"
fi

mkdir -p "$PERSIST" "$PERSIST/logs" "$PERSIST/bin" "$PERSIST/tmp" "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
ok "folder persisten: $PERSIST"

export TMPDIR="$PERSIST/tmp"
# Muse/container: ekstraksi tar sebagai root gagal "tar: Cannot change ownership".
# --no-same-owner membuat tar mengabaikan ownership. Berlaku untuk installer Bun juga.
export TAR_OPTIONS="--no-same-owner"
# Bun duluan di PATH supaya `bun` = yang kita pasang di folder persisten.
export BUN_INSTALL="$BUN_DIR"
export PATH="$BUN_DIR/bin:$PERSIST/bin:$PATH"

[ -n "$MUSE_MODEL" ] || warn "MUSE_MODEL kosong — bridge nggak akan start sampai ini diisi"

# ------------------------------------------------------------------ 1. Bun
step "1. Pasang Bun (runtime bridge)"

if command -v bun >/dev/null 2>&1 && [ -x "$BUN_DIR/bin/bun" ]; then
  ok "Bun sudah terpasang — skip ($(bun --version))"
else
  # Installer resmi Bun. BUN_INSTALL mengarah ke folder persisten.
  curl -fsSL --max-time 120 https://bun.sh/install \
    | bash >"$PERSIST/logs/bun-install.log" 2>&1 \
    || { tail -n 20 "$PERSIST/logs/bun-install.log"; die "gagal pasang Bun (cek koneksi/proxy)"; }
  [ -x "$BUN_DIR/bin/bun" ] || die "Bun terpasang tapi binary tidak ketemu di $BUN_DIR/bin/bun"
  ok "Bun terpasang ($("$BUN_DIR/bin/bun" --version))"
fi
BUN_BIN="$BUN_DIR/bin/bun"

# ------------------------------------------------------- 2. Ambil kode bridge
step "2. Ambil / perbarui kode bridge"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH" >/dev/null 2>&1 \
    && git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH" >/dev/null 2>&1 \
    && ok "kode diperbarui dari origin/$REPO_BRANCH" \
    || warn "gagal update git — pakai yang sudah ada di $APP_DIR"
elif [ -f "$APP_DIR/package.json" ]; then
  ok "kode sudah ada di $APP_DIR (bukan git) — pakai apa adanya"
else
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR" >/dev/null 2>&1 \
      && ok "kode di-clone ke $APP_DIR" \
      || die "gagal clone $REPO_URL (cek koneksi/proxy/akses repo)"
  else
    die "git tidak ada dan $APP_DIR kosong. Pasang git atau upload kode manual ke $APP_DIR."
  fi
fi
[ -f "$APP_DIR/package.json" ] || die "package.json tidak ketemu di $APP_DIR"

# ------------------------------------------------ 3. Install deps + build
step "3. Install dependensi produksi + build"

cd "$APP_DIR" || die "tidak bisa masuk $APP_DIR"
export npm_config_cache="$PERSIST/npm-cache"

# Install produksi di VM (bukan copy node_modules host) agar Baileys cocok arsitektur.
if [ -f bun.lock ]; then
  "$BUN_BIN" install --production --frozen-lockfile >"$PERSIST/logs/bun-install-deps.log" 2>&1 \
    || "$BUN_BIN" install --production >"$PERSIST/logs/bun-install-deps.log" 2>&1 \
    || { tail -n 20 "$PERSIST/logs/bun-install-deps.log"; die "gagal install dependensi"; }
else
  "$BUN_BIN" install --production >"$PERSIST/logs/bun-install-deps.log" 2>&1 \
    || { tail -n 20 "$PERSIST/logs/bun-install-deps.log"; die "gagal install dependensi"; }
fi
ok "dependensi terpasang"

"$BUN_BIN" run build >"$PERSIST/logs/bun-build.log" 2>&1 \
  || { tail -n 20 "$PERSIST/logs/bun-build.log"; die "gagal build (cek log)"; }
[ -f "$APP_DIR/dist/index.js" ] || die "build selesai tapi dist/index.js tidak ada"
ok "build selesai (dist/index.js, dist/pair.js, dist/allow.js)"

# ------------------------------------------------------------- 4. Tulis .env
step "4. Tulis konfigurasi (.env)"

# .env berisi secret (MUSE_API_KEY). Dibuat 600.
touch "$ENVF"; chmod 600 "$ENVF"
{
  printf 'MUSE_BASE_URL=%s\n' "$MUSE_BASE_URL"
  printf 'MUSE_API_KEY=%s\n' "$MUSE_API_KEY"
  printf 'MUSE_MODEL=%s\n' "$MUSE_MODEL"
  [ -n "$MUSE_SYSTEM_PROMPT_FILE" ] && printf 'MUSE_SYSTEM_PROMPT_FILE=%s\n' "$MUSE_SYSTEM_PROMPT_FILE"
  printf 'STATE_DIR=%s\n' "$STATE_DIR"
  [ -n "$WHATSAPP_PHONE_NUMBER" ] && printf 'WHATSAPP_PHONE_NUMBER=%s\n' "$WHATSAPP_PHONE_NUMBER"
  printf 'GROUP_REQUIRE_MENTION=%s\n' "$GROUP_REQUIRE_MENTION"
  printf 'HISTORY_MAX_TURNS=%s\n' "$HISTORY_MAX_TURNS"
  printf 'REQUEST_TIMEOUT_MS=%s\n' "$REQUEST_TIMEOUT_MS"
} > "$ENVF"
ok ".env ditulis (mode 600) -> MUSE_BASE_URL=$MUSE_BASE_URL"

# --------------------------------------------------- 5. Launcher + boot loop
step "5. Bikin launcher + respawn loop"

# Boot loop: jaga bridge tetap hidup. Muse nggak punya systemd. Panggil dari
# Muse Scheduled Task tiap boot, atau lewat launcher `muse-wa`.
cat > "$PERSIST/bin/muse-wa-boot.sh" <<'BOOT'
#!/usr/bin/env bash
# Jalankan Muse WhatsApp Bridge dan jaga tetap hidup (pengganti systemd).
set -uo pipefail
PERSIST="${PERSIST:-$HOME/pdata}"
APP_DIR="$PERSIST/muse-whatsapp-bridge"
ENVF="$APP_DIR/.env"
BUN_BIN="$PERSIST/.bun/bin/bun"
LOG="$PERSIST/logs/muse-wa.log"

export BUN_INSTALL="$PERSIST/.bun"
export PATH="$PERSIST/.bun/bin:$PERSIST/bin:$PATH"
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export TAR_OPTIONS="--no-same-owner"
mkdir -p "$PERSIST/logs"

[ -x "$BUN_BIN" ] || { echo "[muse-wa] bun tidak ada di $BUN_BIN" >>"$PERSIST/logs/boot.log"; exit 1; }
[ -f "$APP_DIR/dist/index.js" ] || { echo "[muse-wa] dist/index.js tidak ada — build dulu" >>"$PERSIST/logs/boot.log"; exit 1; }

# Belum paired? index.js keluar kode 0 dan mencetak instruksi. Loop ini akan
# mencoba lagi tiap 30s sampai creds muncul (setelah kamu pairing manual).
echo "[$(date -Is)] start muse-whatsapp-bridge" >>"$PERSIST/logs/boot.log"
cd "$APP_DIR" || exit 1
while true; do
  "$BUN_BIN" --env-file "$ENVF" run dist/index.js >>"$LOG" 2>&1
  echo "[$(date -Is)] bridge berhenti, restart 10s" >>"$PERSIST/logs/boot.log"
  sleep 10
done
BOOT
chmod +x "$PERSIST/bin/muse-wa-boot.sh"
ok "$PERSIST/bin/muse-wa-boot.sh"

# Launcher utama `muse-wa`: subcommand pairing / allow / start / log.
cat > "$PERSIST/bin/muse-wa" <<'WRAP'
#!/usr/bin/env bash
# muse-wa — kontrol Muse WhatsApp Bridge.
#   muse-wa pair --phone +62...        minta pairing code
#   muse-wa allow dm add +62...        tambah nomor ke allowlist
#   muse-wa allow group add <jid>      tambah grup
#   muse-wa start                      jalankan bridge (respawn loop, foreground)
#   muse-wa up                         jalankan bridge di background (setsid)
#   muse-wa log                        ikuti log bridge
#   muse-wa status                     cek proses & paired
set -uo pipefail
PERSIST="${PERSIST:-$HOME/pdata}"
APP_DIR="$PERSIST/muse-whatsapp-bridge"
ENVF="$APP_DIR/.env"
BUN_BIN="$PERSIST/.bun/bin/bun"

export BUN_INSTALL="$PERSIST/.bun"
export PATH="$PERSIST/.bun/bin:$PERSIST/bin:$PATH"
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export TAR_OPTIONS="--no-same-owner"

[ -x "$BUN_BIN" ] || { echo "[X] bun tidak ada di $BUN_BIN — jalankan ulang muse-setup.sh" >&2; exit 1; }
[ -f "$APP_DIR/package.json" ] || { echo "[X] kode bridge tidak ada di $APP_DIR" >&2; exit 1; }
cd "$APP_DIR" || exit 1

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  pair)   exec "$BUN_BIN" --env-file "$ENVF" run src/cli/pair.ts "$@" ;;
  allow)  exec "$BUN_BIN" --env-file "$ENVF" run src/cli/allow.ts "$@" ;;
  start)  exec bash "$PERSIST/bin/muse-wa-boot.sh" ;;
  up)
    if command -v setsid >/dev/null 2>&1; then
      setsid bash "$PERSIST/bin/muse-wa-boot.sh" >/dev/null 2>&1 </dev/null &
    else
      nohup bash "$PERSIST/bin/muse-wa-boot.sh" >/dev/null 2>&1 </dev/null &
    fi
    echo "[i] bridge dinyalakan di background — log: muse-wa log" ;;
  log)    exec tail -n 100 -f "$PERSIST/logs/muse-wa.log" ;;
  status)
    if pgrep -f 'dist/index.js' >/dev/null 2>&1; then echo "[i] bridge: JALAN"; else echo "[i] bridge: MATI"; fi
    state_dir="$PERSIST/state"
    if [ -f "$ENVF" ]; then
      from_env="$(grep -E '^STATE_DIR=' "$ENVF" 2>/dev/null | tail -n1 | cut -d= -f2-)"
      [ -n "$from_env" ] && state_dir="$from_env"
    fi
    if [ -f "$state_dir/auth/creds.json" ]; then
      echo "[i] paired: YA ($state_dir)"
    else
      echo "[i] paired: BELUM — jalankan: muse-wa pair --phone +62..."
    fi ;;
  *)
    echo "pakai: muse-wa {pair|allow|start|up|log|status}" >&2
    echo "  muse-wa pair --phone +62..." >&2
    echo "  muse-wa allow dm add +62..." >&2
    echo "  muse-wa up        # jalan di background" >&2
    exit 2 ;;
esac
WRAP
chmod +x "$PERSIST/bin/muse-wa"
ok "$PERSIST/bin/muse-wa"

# Autoload: terminal BARU langsung punya `bun` dan `muse-wa`.
MARK="# >>> muse-whatsapp >>>"
BLOCK="$MARK
export BUN_INSTALL=\"\$HOME/pdata/.bun\"
export PATH=\"\$HOME/pdata/.bun/bin:\$HOME/pdata/bin:\$PATH\"
export NO_PROXY=\"localhost,127.0.0.1,::1\${NO_PROXY:+,\$NO_PROXY}\"
export no_proxy=\"\$NO_PROXY\"
export TAR_OPTIONS=\"--no-same-owner\"
# <<< muse-whatsapp <<<"

for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  [ -e "$rc" ] || touch "$rc"
  if grep -qF "$MARK" "$rc" 2>/dev/null; then
    ok "autoload sudah ada di $rc (skip)"
  else
    printf '\n%s\n' "$BLOCK" >> "$rc"
    ok "autoload ditambahkan ke $rc"
  fi
done

# ---------------------------------------------------------------- 6. Verifikasi
step "6. Verifikasi"

FAIL=0

[ -x "$BUN_BIN" ] && ok "Bun: $BUN_BIN" || { err "Bun tidak ada"; FAIL=1; }
[ -f "$APP_DIR/dist/index.js" ] && ok "bridge ter-build: $APP_DIR/dist/index.js" || { err "build bridge tidak ada"; FAIL=1; }
[ -f "$ENVF" ] && ok ".env ada (mode $(stat -c '%a' "$ENVF" 2>/dev/null || echo '?'))" || { err ".env tidak ada"; FAIL=1; }
[ -x "$PERSIST/bin/muse-wa" ] && ok "launcher muse-wa siap" || { err "launcher muse-wa tidak ada"; FAIL=1; }

# Cek endpoint Muse — informasi saja, tidak bikin FAIL (bisa belum ada provider).
step "6b. Cek endpoint Muse (opsional)"
HEALTH_URL="${MUSE_BASE_URL%/}/models"
AUTH_ARG=()
[ -n "$MUSE_API_KEY" ] && AUTH_ARG=(-H "Authorization: Bearer $MUSE_API_KEY")
CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 8 \
  "${AUTH_ARG[@]}" "$HEALTH_URL" 2>/dev/null || echo 000)"
case "$CODE" in
  200)     ok "Muse API merespons 200 di $HEALTH_URL" ;;
  401|403) warn "Muse API menolak (HTTP $CODE) — cek MUSE_API_KEY" ;;
  000)     warn "Muse API tidak merespons di $MUSE_BASE_URL — pastikan endpoint OpenAI-compatible-nya sudah jalan" ;;
  *)       warn "Muse API balas HTTP $CODE (bisa normal tergantung provider)" ;;
esac

cat <<EOF

===========================================================================
 SELESAI
===========================================================================
  Persisten   : $PERSIST
  Bun         : $BUN_DIR
  Bridge      : $APP_DIR
  State dir   : $STATE_DIR
  Konfig      : $ENVF  (MUSE_BASE_URL=$MUSE_BASE_URL)
  Launcher    : muse-wa   (terminal baru; kalau ini lama: source ~/.bashrc)

 LANGKAH MANUAL (sekali saja):
   1. Pastikan endpoint OpenAI-compatible Muse kamu jalan di:
        $MUSE_BASE_URL
      (script ini TIDAK memasang gateway/penyedia model apa pun.)
   2. Pairing nomor WhatsApp (cetak kode 8 karakter):
        muse-wa pair --phone +62...
      Di HP: WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon.
   3. Izinkan nomor yang boleh chat:
        muse-wa allow dm add +62<nomor-kamu>
   4. Jalankan bridge:
        muse-wa up        # background (respawn loop)
        muse-wa log       # lihat log
        muse-wa status    # cek jalan / paired
   5. Biar nyala sendiri tiap VM bangun, daftarkan
        $PERSIST/bin/muse-wa-boot.sh
      di Muse Scheduled Task.

 CATATAN PENTING:
   - Rootfs Muse read-only & dibangun ulang tiap boot. Semua di bawah
     $PERSIST. JANGAN install di luar itu — hilang saat VM restart.
   - Sentinel mengintip koneksi keluar. localhost sudah di-NO_PROXY supaya
     bridge->Muse API tidak lewat proxy.
   - MUSE_BASE_URL menunjuk endpoint OpenAI-compatible yang KAMU sediakan.
     Script ini hanya memasang bridge-nya, bukan penyedia model.
   - Baileys tidak resmi. Pakai nomor cadangan, volume pesan rendah.
   - Ini pemakaian di luar ToS Muse. Risiko ban ada di kamu.
===========================================================================
EOF

[ "$FAIL" = 0 ] || exit 1
