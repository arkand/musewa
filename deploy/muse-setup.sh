#!/usr/bin/env bash
# ===========================================================================
#  muse-setup.sh — pasang Muse WORKER untuk bridge.py di dalam VM Muse
# ===========================================================================
#  Peran VM Muse = WORKER (sandbox): menarik job dari bridge.py lewat pull API
#  (/muse/pending, /muse/answer), menjawab pakai endpoint OpenAI-compatible
#  LOKAL Muse, lalu mengirim balik jawabannya. VM Muse TIDAK meng-host WhatsApp
#  dan TIDAK menjalankan bridge.py — itu hidup di VPS (lihat deploy/prompt.md).
#
#  Cara pakai (dari dalam terminal Muse):
#      BRIDGE_URL=https://xxx.trycloudflare.com \
#      BRIDGE_WORKER_KEY=Muse_kutkey_... \
#      MUSE_BASE_URL=http://127.0.0.1:8080/v1 MUSE_MODEL=nama-model \
#      bash muse-setup.sh
#  atau set dulu env-nya lalu: bash muse-setup.sh
#
#  Yang dilakuin:
#    1. Semua ditaruh di folder PERSISTEN (~/pdata) — rootfs Muse read-only &
#       dibangun ulang tiap boot.
#    2. Pastikan curl + jq ada (worker butuh keduanya).
#    3. Ambil/perbarui kode repo (buat dapat deploy/muse-worker.sh).
#    4. Tulis .env.worker dari input kamu (berisi worker key -> mode 600).
#    5. Bikin launcher + respawn loop (Muse nggak punya systemd).
#
#  PENTING: script ini hanya memasang WORKER-nya. Butuh DUA hal sudah jalan:
#    - bridge.py (OpenAI-compatible endpoint + queue) di VPS, reachable lewat
#      BRIDGE_URL (biasanya tunnel cloudflared), dengan worker key-nya.
#    - SATU endpoint OpenAI-compatible LOKAL milik Muse di MUSE_BASE_URL yang
#      dipakai worker untuk benar-benar menjawab.
#
#  Aman dijalankan berulang: bagian yang sudah ada akan di-skip.
# ===========================================================================
set -uo pipefail

# --------------------------------------------------------------- konfigurasi
PERSIST="${PERSIST:-$HOME/pdata}"          # SATU-SATUNYA folder yang awet di Muse
APP_DIR="$PERSIST/musewa"                   # checkout repo (buat muse-worker.sh)
ENVF="$PERSIST/.env.worker"                 # config worker (berisi secret -> 600)
REPO_URL="${REPO_URL:-https://github.com/arkand/musewa.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"

# --- yang WAJIB kamu isi (atau pakai default) ------------------------------
BRIDGE_URL="${BRIDGE_URL:-}"                           # base URL bridge.py (VPS/tunnel)
BRIDGE_WORKER_KEY="${BRIDGE_WORKER_KEY:-}"             # worker key (role=worker)
MUSE_BASE_URL="${MUSE_BASE_URL:-http://127.0.0.1:8080/v1}"  # Muse lokal
MUSE_MODEL="${MUSE_MODEL:-}"
MUSE_API_KEY="${MUSE_API_KEY:-}"
WORKER_BATCH="${WORKER_BATCH:-3}"
WORKER_INTERVAL="${WORKER_INTERVAL:-5}"
REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-120000}"

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
# kalau tidak worker->Muse lokal malah lewat proxy dan bisa kena Sentinel.
# (BRIDGE_URL yang publik TETAP boleh lewat proxy — itu memang egress keluar.)
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
if [ -n "${HTTPS_PROXY:-}" ]; then
  ok "proxy egress terdeteksi (kredensial tidak ditampilkan)"
else
  warn "HTTPS_PROXY kosong — kalau akses BRIDGE_URL gagal, itu bisa sebabnya"
fi

mkdir -p "$PERSIST" "$PERSIST/logs" "$PERSIST/bin" "$PERSIST/tmp"
ok "folder persisten: $PERSIST"

export TMPDIR="$PERSIST/tmp"
# Muse/container: ekstraksi tar sebagai root gagal "tar: Cannot change ownership".
export TAR_OPTIONS="--no-same-owner"
export PATH="$PERSIST/bin:$PATH"

# --- validasi input WAJIB --------------------------------------------------
[ -n "$BRIDGE_URL" ]        || warn "BRIDGE_URL kosong — worker nggak akan start sampai ini diisi"
[ -n "$BRIDGE_WORKER_KEY" ] || warn "BRIDGE_WORKER_KEY kosong — worker nggak akan start sampai ini diisi"
[ -n "$MUSE_MODEL" ]        || warn "MUSE_MODEL kosong — worker nggak akan start sampai ini diisi"

# ---------------------------------------------------------- 1. curl + jq
step "1. Cek dependensi (curl, jq)"

command -v curl >/dev/null 2>&1 || die "curl tidak ada — pasang dulu (worker butuh curl)"
ok "curl: $(command -v curl)"

if command -v jq >/dev/null 2>&1; then
  ok "jq: $(command -v jq) ($(jq --version 2>/dev/null))"
else
  # Coba unduh jq statis ke folder persisten (tanpa hak root / paket sistem).
  warn "jq tidak ada — coba unduh binary statis ke $PERSIST/bin"
  JQ_ARCH="$(uname -m)"
  case "$JQ_ARCH" in
    x86_64|amd64) JQ_URL="https://github.com/jqlang/jq/releases/latest/download/jq-linux-amd64" ;;
    aarch64|arm64) JQ_URL="https://github.com/jqlang/jq/releases/latest/download/jq-linux-arm64" ;;
    *) JQ_URL="" ;;
  esac
  if [ -n "$JQ_URL" ] && curl -fsSL --max-time 60 "$JQ_URL" -o "$PERSIST/bin/jq" 2>>"$PERSIST/logs/jq-install.log"; then
    chmod +x "$PERSIST/bin/jq"
    "$PERSIST/bin/jq" --version >/dev/null 2>&1 \
      && ok "jq terpasang: $PERSIST/bin/jq" \
      || die "jq terunduh tapi tidak jalan (arsitektur $JQ_ARCH?)"
  else
    die "gagal menyediakan jq (arch=$JQ_ARCH). Pasang jq manual lalu ulangi."
  fi
fi

# ------------------------------------------------------- 2. Ambil kode repo
step "2. Ambil / perbarui kode repo"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH" >/dev/null 2>&1 \
    && git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH" >/dev/null 2>&1 \
    && ok "kode diperbarui dari origin/$REPO_BRANCH" \
    || warn "gagal update git — pakai yang sudah ada di $APP_DIR"
elif [ -f "$APP_DIR/deploy/muse-worker.sh" ]; then
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
WORKER_SRC="$APP_DIR/deploy/muse-worker.sh"
[ -f "$WORKER_SRC" ] || die "deploy/muse-worker.sh tidak ketemu di $APP_DIR"

# Salin poller ke folder bin persisten agar stabil terhadap update checkout.
install -m 0755 "$WORKER_SRC" "$PERSIST/bin/muse-worker.sh" 2>/dev/null \
  || { cp "$WORKER_SRC" "$PERSIST/bin/muse-worker.sh"; chmod +x "$PERSIST/bin/muse-worker.sh"; }
ok "poller: $PERSIST/bin/muse-worker.sh"

# ------------------------------------------------------------- 3. Tulis .env
step "3. Tulis konfigurasi ($ENVF)"

# .env.worker berisi secret (BRIDGE_WORKER_KEY, MUSE_API_KEY). Dibuat 600.
touch "$ENVF"; chmod 600 "$ENVF"
{
  printf 'BRIDGE_URL=%s\n' "$BRIDGE_URL"
  printf 'BRIDGE_WORKER_KEY=%s\n' "$BRIDGE_WORKER_KEY"
  printf 'MUSE_BASE_URL=%s\n' "$MUSE_BASE_URL"
  printf 'MUSE_MODEL=%s\n' "$MUSE_MODEL"
  [ -n "$MUSE_API_KEY" ] && printf 'MUSE_API_KEY=%s\n' "$MUSE_API_KEY"
  printf 'WORKER_BATCH=%s\n' "$WORKER_BATCH"
  printf 'WORKER_INTERVAL=%s\n' "$WORKER_INTERVAL"
  printf 'REQUEST_TIMEOUT_MS=%s\n' "$REQUEST_TIMEOUT_MS"
} > "$ENVF"
ok ".env.worker ditulis (mode 600) -> BRIDGE_URL=${BRIDGE_URL:-<kosong>} MUSE_BASE_URL=$MUSE_BASE_URL"

# --------------------------------------------------- 4. Launcher + boot loop
step "4. Bikin launcher + respawn loop"

# Boot loop: jaga worker tetap hidup. Muse nggak punya systemd. Panggil dari
# Muse Scheduled Task tiap boot, atau lewat launcher `muse-worker`.
cat > "$PERSIST/bin/muse-worker-boot.sh" <<'BOOT'
#!/usr/bin/env bash
# Jalankan Muse worker dan jaga tetap hidup (pengganti systemd).
set -uo pipefail
PERSIST="${PERSIST:-$HOME/pdata}"
ENVF="$PERSIST/.env.worker"
WORKER="$PERSIST/bin/muse-worker.sh"
LOG="$PERSIST/logs/muse-worker.log"

export PATH="$PERSIST/bin:$PATH"
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export TAR_OPTIONS="--no-same-owner"
mkdir -p "$PERSIST/logs"

[ -f "$WORKER" ] || { echo "[muse-worker] $WORKER tidak ada — jalankan muse-setup.sh" >>"$PERSIST/logs/boot.log"; exit 1; }
[ -f "$ENVF" ]   || { echo "[muse-worker] $ENVF tidak ada — jalankan muse-setup.sh" >>"$PERSIST/logs/boot.log"; exit 1; }

echo "[$(date -Is 2>/dev/null || date)] start muse-worker" >>"$PERSIST/logs/boot.log"
while true; do
  # Muat .env.worker ke environment lalu jalankan poller.
  set -a; . "$ENVF"; set +a
  bash "$WORKER" >>"$LOG" 2>&1
  echo "[$(date -Is 2>/dev/null || date)] worker berhenti, restart 10s" >>"$PERSIST/logs/boot.log"
  sleep 10
done
BOOT
chmod +x "$PERSIST/bin/muse-worker-boot.sh"
ok "$PERSIST/bin/muse-worker-boot.sh"

# Launcher utama `muse-worker`: start / up / log / status / once.
cat > "$PERSIST/bin/muse-worker" <<'WRAP'
#!/usr/bin/env bash
# muse-worker — kontrol Muse worker (pull API bridge.py).
#   muse-worker start     jalankan worker (respawn loop, foreground)
#   muse-worker up        jalankan worker di background (setsid)
#   muse-worker once      satu putaran poll+answer lalu keluar (buat tes)
#   muse-worker log       ikuti log worker
#   muse-worker status    cek proses jalan/mati + config ringkas
set -uo pipefail
PERSIST="${PERSIST:-$HOME/pdata}"
ENVF="$PERSIST/.env.worker"
WORKER="$PERSIST/bin/muse-worker.sh"

export PATH="$PERSIST/bin:$PATH"
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
export TAR_OPTIONS="--no-same-owner"

[ -f "$WORKER" ] || { echo "[X] $WORKER tidak ada — jalankan ulang muse-setup.sh" >&2; exit 1; }
[ -f "$ENVF" ]   || { echo "[X] $ENVF tidak ada — jalankan ulang muse-setup.sh" >&2; exit 1; }

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  start) set -a; . "$ENVF"; set +a; exec bash "$PERSIST/bin/muse-worker-boot.sh" ;;
  up)
    if command -v setsid >/dev/null 2>&1; then
      setsid bash "$PERSIST/bin/muse-worker-boot.sh" >/dev/null 2>&1 </dev/null &
    else
      nohup bash "$PERSIST/bin/muse-worker-boot.sh" >/dev/null 2>&1 </dev/null &
    fi
    echo "[i] worker dinyalakan di background — log: muse-worker log" ;;
  once)  set -a; . "$ENVF"; set +a; exec env WORKER_INTERVAL=0 WORKER_ONCE=1 bash "$WORKER" ;;
  log)   exec tail -n 100 -f "$PERSIST/logs/muse-worker.log" ;;
  status)
    if pgrep -f 'muse-worker.sh' >/dev/null 2>&1; then echo "[i] worker: JALAN"; else echo "[i] worker: MATI"; fi
    if [ -f "$ENVF" ]; then
      bu="$(grep -E '^BRIDGE_URL=' "$ENVF" 2>/dev/null | tail -n1 | cut -d= -f2-)"
      mu="$(grep -E '^MUSE_BASE_URL=' "$ENVF" 2>/dev/null | tail -n1 | cut -d= -f2-)"
      mm="$(grep -E '^MUSE_MODEL=' "$ENVF" 2>/dev/null | tail -n1 | cut -d= -f2-)"
      echo "[i] bridge   : ${bu:-<kosong>}"
      echo "[i] muse     : ${mu:-<kosong>} (model ${mm:-<kosong>})"
      grep -qE '^BRIDGE_WORKER_KEY=.+' "$ENVF" 2>/dev/null \
        && echo "[i] worker key: ADA (tidak ditampilkan)" \
        || echo "[i] worker key: BELUM diisi"
    fi ;;
  *)
    echo "pakai: muse-worker {start|up|once|log|status}" >&2
    echo "  muse-worker up        # jalan di background" >&2
    echo "  muse-worker once      # satu putaran buat tes" >&2
    exit 2 ;;
esac
WRAP
chmod +x "$PERSIST/bin/muse-worker"
ok "$PERSIST/bin/muse-worker"

# Autoload: terminal BARU langsung punya `muse-worker` di PATH.
MARK="# >>> muse-worker >>>"
BLOCK="$MARK
export PATH=\"\$HOME/pdata/bin:\$PATH\"
export NO_PROXY=\"localhost,127.0.0.1,::1\${NO_PROXY:+,\$NO_PROXY}\"
export no_proxy=\"\$NO_PROXY\"
export TAR_OPTIONS=\"--no-same-owner\"
# <<< muse-worker <<<"

for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  [ -e "$rc" ] || touch "$rc"
  if grep -qF "$MARK" "$rc" 2>/dev/null; then
    ok "autoload sudah ada di $rc (skip)"
  else
    printf '\n%s\n' "$BLOCK" >> "$rc"
    ok "autoload ditambahkan ke $rc"
  fi
done

# ---------------------------------------------------------------- 5. Verifikasi
step "5. Verifikasi"

FAIL=0
command -v curl >/dev/null 2>&1 && ok "curl ada" || { err "curl tidak ada"; FAIL=1; }
command -v jq   >/dev/null 2>&1 || [ -x "$PERSIST/bin/jq" ] && ok "jq ada" || { err "jq tidak ada"; FAIL=1; }
[ -x "$PERSIST/bin/muse-worker.sh" ] && ok "poller siap" || { err "poller tidak ada"; FAIL=1; }
[ -x "$PERSIST/bin/muse-worker" ]    && ok "launcher muse-worker siap" || { err "launcher tidak ada"; FAIL=1; }
[ -f "$ENVF" ] && ok ".env.worker ada (mode $(stat -c '%a' "$ENVF" 2>/dev/null || echo '?'))" || { err ".env.worker tidak ada"; FAIL=1; }

# Cek bridge + Muse lokal — informasi saja, tidak bikin FAIL.
step "5b. Cek koneksi (opsional)"

if [ -n "$BRIDGE_URL" ]; then
  HCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BRIDGE_URL%/}/health" 2>/dev/null || echo 000)"
  case "$HCODE" in
    200) ok "bridge /health 200 di ${BRIDGE_URL%/}/health" ;;
    000) warn "bridge tak terjangkau di $BRIDGE_URL (tunnel belum jalan?)" ;;
    *)   warn "bridge /health balas HTTP $HCODE" ;;
  esac
  if [ -n "$BRIDGE_WORKER_KEY" ]; then
    PCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -H "Authorization: Bearer $BRIDGE_WORKER_KEY" \
      "${BRIDGE_URL%/}/muse/pending?limit=1" 2>/dev/null || echo 000)"
    case "$PCODE" in
      200) ok "worker key valid (/muse/pending 200)" ;;
      401|403) warn "worker key DITOLAK (HTTP $PCODE) — cek BRIDGE_WORKER_KEY / role=worker" ;;
      000) warn "tidak bisa cek /muse/pending (bridge tak terjangkau)" ;;
      *)   warn "/muse/pending balas HTTP $PCODE" ;;
    esac
  fi
else
  warn "BRIDGE_URL kosong — lewati cek bridge"
fi

MHEALTH="${MUSE_BASE_URL%/}/models"
AUTH_ARG=()
[ -n "$MUSE_API_KEY" ] && AUTH_ARG=(-H "Authorization: Bearer $MUSE_API_KEY")
MCODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 8 \
  ${AUTH_ARG[@]+"${AUTH_ARG[@]}"} "$MHEALTH" 2>/dev/null || echo 000)"
case "$MCODE" in
  200)     ok "Muse lokal merespons 200 di $MHEALTH" ;;
  401|403) warn "Muse lokal menolak (HTTP $MCODE) — cek MUSE_API_KEY" ;;
  000)     warn "Muse lokal tidak merespons di $MUSE_BASE_URL — pastikan endpoint OpenAI-compatible-nya jalan" ;;
  *)       warn "Muse lokal balas HTTP $MCODE (bisa normal tergantung provider)" ;;
esac

cat <<EOF

===========================================================================
 SELESAI
===========================================================================
  Persisten   : $PERSIST
  Repo        : $APP_DIR
  Poller      : $PERSIST/bin/muse-worker.sh
  Konfig      : $ENVF  (mode 600)
  Launcher    : muse-worker   (terminal baru; kalau ini lama: source ~/.bashrc)

 LANGKAH MANUAL (sekali saja):
   1. Pastikan bridge.py jalan di VPS dan BRIDGE_URL bisa diakses dari VM:
        curl -s ${BRIDGE_URL:-https://xxx.trycloudflare.com}/health
   2. Pastikan endpoint OpenAI-compatible LOKAL Muse jalan di:
        $MUSE_BASE_URL
   3. Tes satu putaran (tanpa respawn loop):
        muse-worker once
   4. Jalankan worker terus-menerus:
        muse-worker up        # background (respawn loop)
        muse-worker log       # lihat log
        muse-worker status    # cek jalan + config ringkas
   5. Biar nyala sendiri tiap VM bangun, daftarkan
        $PERSIST/bin/muse-worker-boot.sh
      di Muse Scheduled Task.

 CATATAN PENTING:
   - Rootfs Muse read-only & dibangun ulang tiap boot. Semua di bawah
     $PERSIST. JANGAN install di luar itu — hilang saat VM restart.
   - Sentinel mengintip koneksi keluar. localhost sudah di-NO_PROXY supaya
     worker->Muse lokal tidak lewat proxy. BRIDGE_URL yang publik memang
     lewat egress (boleh kena proxy).
   - Worker DIAM kecuali ada error nyata (bridge tak terjangkau, auth salah,
     Muse lokal error). Tidak pernah mencetak isi pesan atau secret.
   - bridge.py & WhatsApp bridge ada di VPS, bukan di sini (lihat
     deploy/prompt.md). VM ini cuma WORKER.
   - Ini pemakaian di luar ToS Muse. Risiko ban ada di kamu.
===========================================================================
EOF

[ "$FAIL" = 0 ] || exit 1
