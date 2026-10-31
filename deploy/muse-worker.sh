#!/usr/bin/env bash
# ===========================================================================
#  muse-worker.sh — Muse VM worker loop for the bridge.py pull API
# ===========================================================================
#  Peran VM Muse dalam arsitektur = WORKER (sandbox), bukan host WhatsApp.
#  Loop ini:
#    1. GET  $BRIDGE_URL/muse/pending?limit=$WORKER_BATCH   (Bearer worker key)
#    2. untuk tiap job: relay job.request ke endpoint OpenAI-compatible LOKAL
#       Muse ($MUSE_BASE_URL/chat/completions, stream dipaksa false)
#    3. POST $BRIDGE_URL/muse/answer {"id","content"} dengan
#       choices[0].message.content
#    4. kalau Muse lokal gagal / jawaban kosong -> POST /muse/release {"id"}
#       supaya job balik ke pending dan bisa dicoba lagi.
#
#  DIAM kecuali ada error nyata (bridge tak terjangkau, auth salah, Muse lokal
#  error). Tidak mencetak isi pesan. Tidak menampilkan secret.
#
#  Dipanggil oleh respawn loop (muse-worker-boot.sh) atau manual:
#      BRIDGE_URL=https://xxx.trycloudflare.com \
#      BRIDGE_WORKER_KEY=Muse_kutkey_... \
#      MUSE_BASE_URL=http://127.0.0.1:8080/v1 MUSE_MODEL=nama bash muse-worker.sh
#
#  Env (semua bisa dari .env.worker yang ditulis muse-setup.sh):
#    BRIDGE_URL         (WAJIB) base URL bridge.py, mis. https://xxx.trycloudflare.com
#    BRIDGE_WORKER_KEY  (WAJIB) worker key (role=worker) dari bridge.py keygen
#    MUSE_BASE_URL      (WAJIB) endpoint OpenAI-compatible lokal Muse (+ /v1)
#    MUSE_MODEL         (WAJIB) nama model yang dikirim ke Muse lokal
#    MUSE_API_KEY       (opsional) Bearer untuk Muse lokal
#    WORKER_BATCH       jumlah job per poll (default 3, clamp 1..10)
#    WORKER_INTERVAL    jeda antar poll saat antrean kosong (detik, default 5)
#    REQUEST_TIMEOUT_MS timeout panggilan Muse lokal (default 120000)
# ===========================================================================
set -uo pipefail

BRIDGE_URL="${BRIDGE_URL:-}"
BRIDGE_WORKER_KEY="${BRIDGE_WORKER_KEY:-}"
MUSE_BASE_URL="${MUSE_BASE_URL:-}"
MUSE_MODEL="${MUSE_MODEL:-}"
MUSE_API_KEY="${MUSE_API_KEY:-}"
WORKER_BATCH="${WORKER_BATCH:-3}"
WORKER_INTERVAL="${WORKER_INTERVAL:-5}"
REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-120000}"
WORKER_ONCE="${WORKER_ONCE:-0}"   # 1 = satu putaran poll(+answer) lalu keluar

# localhost JANGAN lewat proxy (Muse memaksa egress lewat HTTPS_PROXY).
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

log() { printf '[%s] muse-worker: %s\n' "$(date -Is 2>/dev/null || date)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl tidak ada"
command -v jq   >/dev/null 2>&1 || die "jq tidak ada (butuh untuk parse JSON job)"

[ -n "$BRIDGE_URL" ]        || die "BRIDGE_URL kosong"
[ -n "$BRIDGE_WORKER_KEY" ] || die "BRIDGE_WORKER_KEY kosong"
[ -n "$MUSE_BASE_URL" ]     || die "MUSE_BASE_URL kosong"
[ -n "$MUSE_MODEL" ]        || die "MUSE_MODEL kosong"

BRIDGE_URL="${BRIDGE_URL%/}"
MUSE_BASE_URL="${MUSE_BASE_URL%/}"
case "$WORKER_BATCH" in ''|*[!0-9]*) WORKER_BATCH=3 ;; esac
[ "$WORKER_BATCH" -lt 1 ]  && WORKER_BATCH=1
[ "$WORKER_BATCH" -gt 10 ] && WORKER_BATCH=10
# timeout curl (detik) untuk panggilan Muse lokal, dari ms + margin.
MUSE_CURL_TIMEOUT=$(( REQUEST_TIMEOUT_MS / 1000 + 5 ))
[ "$MUSE_CURL_TIMEOUT" -lt 10 ] && MUSE_CURL_TIMEOUT=10

# ---- helper: POST /muse/release (best effort) -----------------------------
release_job() {
  local id="$1"
  curl -s -o /dev/null --noproxy '*' --max-time 15 \
    -H "Authorization: Bearer $BRIDGE_WORKER_KEY" \
    -H 'content-type: application/json' \
    -d "$(jq -cn --arg id "$id" '{id:$id}')" \
    "$BRIDGE_URL/muse/release" 2>/dev/null || true
}

# ---- helper: jawab satu job -----------------------------------------------
# $1 = job id, $2 = job.request (JSON string)
answer_job() {
  local id="$1" request="$2"

  # Bangun body untuk Muse lokal: pakai messages dari request, model dari env,
  # paksa stream=false. Kalau messages tak ada/invalid -> lepas job.
  local body
  body="$(jq -cn --argjson req "$request" --arg model "$MUSE_MODEL" '
    ($req.messages // null) as $m
    | if ($m | type) == "array" and ($m | length) > 0
      then {model:$model, messages:$m, stream:false}
      else empty end
  ' 2>/dev/null)"
  if [ -z "$body" ]; then
    log "job $id: request tanpa messages valid — release"
    release_job "$id"
    return
  fi

  local auth=()
  [ -n "$MUSE_API_KEY" ] && auth=(-H "Authorization: Bearer $MUSE_API_KEY")

  local resp code
  resp="$(curl -s -w $'\n%{http_code}' --noproxy '*' --max-time "$MUSE_CURL_TIMEOUT" \
    ${auth[@]+"${auth[@]}"} -H 'content-type: application/json' \
    -d "$body" "$MUSE_BASE_URL/chat/completions" 2>/dev/null)"
  code="$(printf '%s' "$resp" | tail -n1)"
  resp="$(printf '%s' "$resp" | sed '$d')"

  if [ "$code" != "200" ]; then
    log "job $id: Muse lokal balas HTTP ${code:-000} — release"
    release_job "$id"
    return
  fi

  local content
  content="$(printf '%s' "$resp" | jq -r '.choices[0].message.content // empty' 2>/dev/null)"
  if [ -z "$content" ]; then
    log "job $id: jawaban Muse lokal kosong/invalid — release"
    release_job "$id"
    return
  fi

  # POST /muse/answer. 200 = terkirim; 400 (kosong) sudah kita hindari; 404 =
  # lease hilang (mis. sudah expired) -> diamkan, job akan dijemput lagi.
  local acode
  acode="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 30 \
    -H "Authorization: Bearer $BRIDGE_WORKER_KEY" \
    -H 'content-type: application/json' \
    -d "$(jq -cn --arg id "$id" --arg c "$content" '{id:$id, content:$c}')" \
    "$BRIDGE_URL/muse/answer" 2>/dev/null || echo 000)"
  case "$acode" in
    200) : ;;  # sukses, diam
    404) log "job $id: lease sudah hilang saat answer (HTTP 404)" ;;
    401|403) die "answer ditolak (HTTP $acode) — cek BRIDGE_WORKER_KEY" ;;
    *)   log "job $id: answer balas HTTP $acode" ;;
  esac
}

# ---- loop utama -----------------------------------------------------------
log "worker start -> bridge=$BRIDGE_URL muse=$MUSE_BASE_URL model=$MUSE_MODEL batch=$WORKER_BATCH"

while true; do
  pend="$(curl -s -w $'\n%{http_code}' --noproxy '*' --max-time 30 \
    -H "Authorization: Bearer $BRIDGE_WORKER_KEY" \
    "$BRIDGE_URL/muse/pending?limit=$WORKER_BATCH" 2>/dev/null)"
  pcode="$(printf '%s' "$pend" | tail -n1)"
  pbody="$(printf '%s' "$pend" | sed '$d')"

  case "$pcode" in
    200) : ;;
    401|403) die "pending ditolak (HTTP $pcode) — cek BRIDGE_WORKER_KEY / role=worker" ;;
    000) log "bridge tak terjangkau di $BRIDGE_URL — retry ${WORKER_INTERVAL}s"; sleep "$WORKER_INTERVAL"; continue ;;
    *)   log "pending balas HTTP $pcode — retry ${WORKER_INTERVAL}s"; sleep "$WORKER_INTERVAL"; continue ;;
  esac

  count="$(printf '%s' "$pbody" | jq -r '.count // 0' 2>/dev/null || echo 0)"
  case "$count" in ''|*[!0-9]*) count=0 ;; esac

  if [ "$count" -eq 0 ]; then
    [ "$WORKER_ONCE" = "1" ] && { log "once: antrean kosong, keluar"; exit 0; }
    sleep "$WORKER_INTERVAL"
    continue
  fi

  # Proses tiap job secara berurutan. id dan request (compact) dipisah baris.
  n="$(printf '%s' "$pbody" | jq -r '.jobs | length' 2>/dev/null || echo 0)"
  i=0
  while [ "$i" -lt "$n" ]; do
    jid="$(printf '%s' "$pbody" | jq -r ".jobs[$i].id" 2>/dev/null)"
    jreq="$(printf '%s' "$pbody" | jq -c ".jobs[$i].request // {}" 2>/dev/null)"
    i=$((i + 1))
    [ -n "$jid" ] && [ "$jid" != "null" ] || continue
    answer_job "$jid" "$jreq"
  done
  [ "$WORKER_ONCE" = "1" ] && { log "once: $n job diproses, keluar"; exit 0; }
  # langsung poll lagi (mungkin masih ada antrean), tanpa jeda.
done
