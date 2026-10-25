# t3-phone: runs Claude Code and a T3 Code server in Ubuntu (proot-distro) inside Termux.
# T3 Code's phone setup runs this script through Termux and saves a copy as
# $PREFIX/bin/t3-phone; running setup again overwrites that copy.
T3_PHONE_SCRIPT_VERSION=1
set -u

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
DISTRO=ubuntu
STATE_DIR="$HOME/.t3-phone"
PORT="${T3_PHONE_PORT:-$(cat "$STATE_DIR/port" 2>/dev/null || echo 3773)}"
INSTALL_STEPS=4
SHARED_STORAGE="${T3_PHONE_SHARED_STORAGE:-/storage/emulated/0}"
# Termux's bin goes last so agents can still call termux-* commands from Ubuntu.
UBUNTU_PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PREFIX/bin"

# Everything runs as proot's fake root: a separate user would add no isolation (it is all
# the Termux app's uid) and would sign people who set Claude up by hand out. Claude Code
# refuses full access as root unless IS_SANDBOX is set.
in_ubuntu() {
  proot-distro login "$DISTRO" -- /usr/bin/env HOME=/root PATH="$UBUNTU_PATH" IS_SANDBOX=1 "$@"
}

# proot-distro 5 keeps containers/<name>/rootfs and moves 4.x's installed-rootfs/<name>
# there on first login.
ubuntu_rootfs() {
  for dir in "$PREFIX/var/lib/proot-distro/containers/$DISTRO/rootfs" \
    "$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"; do
    if [ -e "$dir/usr/bin/env" ]; then
      echo "$dir"
      return 0
    fi
  done
  return 1
}

server_up() {
  curl -fsS -m 2 "http://127.0.0.1:$PORT/.well-known/t3/environment" >/dev/null 2>&1
}

install_lock_pid() {
  pid=$(cat "$STATE_DIR/install.lock/pid" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

# Fields of /proc/<pid>/stat after the command name, which may contain spaces:
# 2 is the parent pid, 20 the start time that tells a reused pid apart.
proc_field() {
  sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f "$2"
}

descends_from() {
  pid=$1
  for _ in 1 2 3 4 5 6; do
    pid=$(proc_field "$pid" 2)
    [ -n "$pid" ] && [ "$pid" != 0 ] || return 1
    [ "$pid" = "$2" ] && return 0
  done
  return 1
}

# ~/storage survives a revoked permission, so try reading shared storage itself.
storage_allowed() {
  ls "$SHARED_STORAGE" >/dev/null 2>&1
}

return_to_app() {
  [ -n "${1:-}" ] || return 0
  sleep 2
  am start -n "$1" >/dev/null 2>&1 || true
}

# Prints key=value lines. The app reads them after every return from Termux.
cmd_status() {
  echo "script=$T3_PHONE_SCRIPT_VERSION"
  echo "launcher=$(sed -n 's/^T3_PHONE_SCRIPT_VERSION=//p' "$PREFIX/bin/t3-phone" 2>/dev/null | head -n 1)"
  echo "port=$PORT"
  if storage_allowed; then echo "storage=true"; else echo "storage=false"; fi
  if server_up; then echo "server=true"; else echo "server=false"; fi
  if [ -f "$STATE_DIR/install.state" ]; then
    sed -n 's/^\(status\|step\|total\|message\)=/install_\1=/p' "$STATE_DIR/install.state"
  fi
  if install_lock_pid >/dev/null; then echo "install_running=true"; else echo "install_running=false"; fi
  if ! command -v proot-distro >/dev/null 2>&1; then
    echo "proot=false"
    return 0
  fi
  echo "proot=true"
  rootfs=$(ubuntu_rootfs) || {
    echo "ubuntu=false"
    return 0
  }
  echo "ubuntu=true"
  echo "environment_id=$(cat "$rootfs/root/.t3/userdata/environment-id" 2>/dev/null)"
  in_ubuntu /bin/sh -s <<'UBUNTU'
claude=$(command -v claude 2>/dev/null)
if [ -n "$claude" ]; then
  target=$(readlink -f "$claude")
  case "$target" in
    */claude/versions/*) echo "claude_version=${target##*/}" ;;
    *) echo "claude_version=$("$claude" --version 2>/dev/null | head -n 1 | cut -d ' ' -f 1)" ;;
  esac
  auth=$("$claude" auth status --json 2>/dev/null)
  case "$auth" in
    *'"loggedIn": true'* | *'"loggedIn":true'*) echo "claude_signed_in=true" ;;
    *) echo "claude_signed_in=false" ;;
  esac
  plan=$(printf '%s\n' "$auth" | sed -n 's/.*"subscriptionType": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -z "$plan" ] || echo "claude_plan=$plan"
fi
t3=$(command -v t3 2>/dev/null)
if [ -n "$t3" ]; then
  target=$(readlink -f "$t3")
  case "$target" in
    */runtime/versions/*/t3) target=${target%/t3}; echo "t3_version=${target##*/}" ;;
    *) echo "t3_version=installed" ;;
  esac
fi
UBUNTU
}

save_launcher() {
  # Run through `bash -c`, the script is in BASH_EXECUTION_STRING. Run from the saved file,
  # the copy is already in place.
  [ -n "${BASH_EXECUTION_STRING:-}" ] || return 0
  printf '#!%s/bin/bash\n%s\n' "$PREFIX" "$BASH_EXECUTION_STRING" > "$PREFIX/bin/t3-phone" \
    && chmod 755 "$PREFIX/bin/t3-phone"
}

# Only adds what is missing: an existing Ubuntu, Claude Code, sign-in, shell config and
# aliases are left as they are.
cmd_install() {
  app_component="${1:-}"
  device_name="${2:-}"
  step=0
  mkdir -p "$STATE_DIR"
  record() {
    printf 'status=%s\nstep=%s\ntotal=%s\nmessage=%s\n' "$1" "$step" "$INSTALL_STEPS" "$2" \
      > "$STATE_DIR/install.state.tmp" && mv "$STATE_DIR/install.state.tmp" "$STATE_DIR/install.state"
  }
  say() {
    step=$1
    shift
    record running "$*"
    printf '\n\033[1;34m[%s/%s]\033[0m \033[1m%s\033[0m\n' "$step" "$INSTALL_STEPS" "$*"
  }
  fail() {
    record failed "$*"
    printf '\n\033[1;31mSetup stopped: %s\033[0m\n' "$*"
    printf 'Fix the problem above, then tap Try again in T3 Code. Finished parts are skipped.\n'
    exit 1
  }

  # mkdir is atomic: of two installers started together, one gets the lock. A lock left by
  # an installer Android killed is cleared once, and losing that retry means another won.
  if ! mkdir "$STATE_DIR/install.lock" 2>/dev/null; then
    if other=$(install_lock_pid); then
      echo "Setup is already running in another Termux session (process $other)."
      exit 0
    fi
    rm -rf "$STATE_DIR/install.lock"
    if ! mkdir "$STATE_DIR/install.lock" 2>/dev/null; then
      echo "Setup is already running in another Termux session."
      exit 0
    fi
  fi
  echo "$$" > "$STATE_DIR/install.lock/pid"
  trap 'finish_install' EXIT
  finish_install() {
    [ "$(cat "$STATE_DIR/install.lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$STATE_DIR/install.lock"
    # The server takes its own wake lock; only release the one setup took.
    server_up || termux-wake-unlock 2>/dev/null || true
  }
  termux-wake-lock 2>/dev/null || true
  printf '\033[1mT3 Code phone setup\033[0m\n'

  if ! storage_allowed; then
    printf '\nAllow storage access if Android asks, so agents can reach your files.\n'
    termux-setup-storage || true
  fi
  say 1 "Termux packages"
  if ! command -v proot-distro >/dev/null 2>&1; then
    pkg upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
      || fail "Termux packages didn't update. Check your internet connection."
    pkg install -y proot-distro || fail "proot-distro didn't install."
  fi
  say 2 "Ubuntu"
  if ! ubuntu_rootfs >/dev/null; then
    proot-distro install "$DISTRO" || fail "Ubuntu didn't install. Check your internet connection."
  fi

  say 3 "Claude Code and T3 Code in Ubuntu"
  in_ubuntu env DEVICE_NAME="$device_name" /bin/bash -s <<'UBUNTU' || fail "Installing inside Ubuntu failed."
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
missing=""
for package in ca-certificates curl git openssh-client procps ripgrep; do
  dpkg -s "$package" >/dev/null 2>&1 || missing="$missing $package"
done
if [ -n "$missing" ]; then
  apt-get update
  apt-get install -y $missing
fi
export PATH="/root/.local/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  echo "Claude Code is already installed."
else
  curl -fsSL https://claude.ai/install.sh | bash
fi
if command -v t3 >/dev/null 2>&1; then
  echo "T3 Code is already installed."
else
  curl -fsSL https://t3.codes/install.sh | T3CODE_CHANNEL=nightly sh
fi
command -v claude >/dev/null || { echo "Claude Code isn't on PATH after installing." >&2; exit 1; }
command -v t3 >/dev/null || { echo "T3 Code isn't on PATH after installing." >&2; exit 1; }
grep -qs 'HOME/.local/bin' /root/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> /root/.bashrc
# The server names its environment after PRETTY_HOSTNAME.
if [ -n "${DEVICE_NAME:-}" ] && [ ! -f /etc/machine-info ]; then
  printf 'PRETTY_HOSTNAME="%s"\n' "$(printf '%s' "$DEVICE_NAME" | tr -d '"\\')" > /etc/machine-info
fi
# Lets `claude auth login` open the phone's browser.
if ! command -v xdg-open >/dev/null 2>&1; then
  printf '#!/bin/sh\nexec /data/data/com.termux/files/usr/bin/termux-open-url "$1"\n' > /usr/local/bin/xdg-open
  chmod 755 /usr/local/bin/xdg-open
fi
UBUNTU

  say 4 "The t3-phone command"
  save_launcher || fail "Couldn't write $PREFIX/bin/t3-phone."

  record done "Done"
  printf '\n\033[1;32mDone.\033[0m Returning to T3 Code...\n'
  return_to_app "$app_component"
}

# Runs as a Termux background task, so nothing depends on a terminal being on screen.
# Output goes to a log the app reads back when the server doesn't come up.
cmd_serve() {
  if server_up; then
    echo "T3 Code is already running on port $PORT."
    return 0
  fi
  mkdir -p "$STATE_DIR"
  termux-wake-lock 2>/dev/null || true
  # exec keeps this pid through proot-distro into proot, so stop can find it again.
  echo "$$ $(proc_field "$$" 20)" > "$STATE_DIR/server.pid"
  exec proot-distro login "$DISTRO" -- /usr/bin/env HOME=/root PATH="$UBUNTU_PATH" IS_SANDBOX=1 \
    t3 serve --host 127.0.0.1 --port "$PORT" > "$STATE_DIR/server.log" 2>&1
}

# Signals only the process tree serve started: a pid is trusted only while its start time
# still matches, so a crashed server's reused pid is left alone.
cmd_stop() {
  read -r launcher started 2>/dev/null < "$STATE_DIR/server.pid" || launcher=""
  if [ -z "$launcher" ] || [ "$(proc_field "$launcher" 20)" != "${started:-}" ]; then
    rm -f "$STATE_DIR/server.pid"
    termux-wake-unlock 2>/dev/null || true
    if server_up; then
      echo "T3 Code is running, but not from t3-phone serve. Stop it where it was started."
      return 1
    fi
    echo "T3 Code wasn't running."
    return 0
  fi
  rootfs=$(ubuntu_rootfs) || rootfs=""
  server=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$rootfs/root/.t3/userdata/server-runtime.json" 2>/dev/null | head -n 1)
  # Signal the server itself so it shuts down cleanly; proot exits after it. Only a
  # descendant of serve's proot counts (proot-distro 4 puts su and a shell in between).
  if [ -n "$server" ] && descends_from "$server" "$launcher"; then
    kill "$server"
  else
    kill "$launcher"
  fi
  rm -f "$STATE_DIR/server.pid"
  termux-wake-unlock 2>/dev/null || true
  echo "Stopped T3 Code."
}

cmd_pair() {
  output=$(in_ubuntu t3 pair --label "T3 Code app on this phone" 2>&1)
  url=$(printf '%s\n' "$output" | sed -n 's/^Pairing URL: //p' | head -n 1)
  if [ -z "$url" ]; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  echo "pairing_url=$url"
}

cmd_login() {
  if in_ubuntu claude auth login; then
    printf '\n\033[1;32mSigned in.\033[0m Returning to T3 Code...\n'
    return_to_app "${1:-}"
  else
    printf '\nSign-in did not finish. Tap Sign in in T3 Code to try again.\n'
  fi
}

cmd_log() {
  tail -n "${1:-30}" "$STATE_DIR/server.log" 2>/dev/null
}

cmd_storage() {
  termux-setup-storage
  return_to_app "${1:-}"
}

case "${1:-}" in
  status) cmd_status ;;
  install) shift; cmd_install "$@" ;;
  serve) cmd_serve ;;
  stop) cmd_stop ;;
  pair) cmd_pair ;;
  login) shift; cmd_login "$@" ;;
  logout) in_ubuntu claude auth logout ;;
  log) shift; cmd_log "$@" ;;
  storage) shift; cmd_storage "$@" ;;
  save-launcher) save_launcher ;;
  shell) exec proot-distro login "$DISTRO" ;;
  *)
    echo "Usage: t3-phone shell | status | install | serve | stop | login | logout"
    echo "  shell   open Ubuntu (run 'claude auth login' there to sign in)"
    ;;
esac
