# Installs, updates and inspects the on-device runtime's tools. Runs inside its Ubuntu as
# proot's fake root, one step per run: bash -s -- <step>. Every step skips what is in place.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="$HOME/.local/bin:$PATH"
NODE_CHANNEL=https://nodejs.org/dist/latest-v24.x
CLAUDE_LIST=/etc/apt/sources.list.d/claude-code.list
# The fork whose releases carry a Linux arm64 server (FORK.md).
RELEASE_REPO=tebiggs/t3code
T3_LINK="$HOME/.local/bin/t3"
T3_VERSIONS="$HOME/.t3/runtime/versions"

apt_install() {
  apt-get install -y --no-install-recommends "$@"
}

# The base image has no CA certificates, so this uses the archive's plain-http mirrors; apt
# checks the signed indexes either way. libatomic1: the arm64 t3 binary links it.
step_packages() {
  apt-get update
  apt_install ca-certificates curl git libatomic1 openssh-client procps ripgrep
}

# Ubuntu's nodejs is older than the server supports, and its npm pulls in hundreds of packages.
step_node() {
  case "$(uname -m)" in
    aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "Node.js has no Linux build for $(uname -m)." >&2; exit 1 ;;
  esac
  sums=$(curl -fsSL "$NODE_CHANNEL/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | grep -o "node-v[0-9.]*-linux-$arch\.tar\.gz" | head -n 1 || true)
  [ -n "$file" ] || { echo "$NODE_CHANNEL lists no linux-$arch tarball." >&2; exit 1; }
  version=${file#node-}
  version=${version%-linux-*}
  if [ "$(/opt/node/bin/node --version 2>/dev/null)" = "$version" ]; then
    echo "Node.js $version is already installed."
    return
  fi
  work=$(mktemp -d)
  curl -fsSL -o "$work/$file" "$NODE_CHANNEL/$file"
  (cd "$work" && printf '%s\n' "$sums" | grep "  $file\$" | sha256sum -c -)
  rm -rf /opt/node.new
  mkdir -p /opt/node.new
  tar -xzf "$work/$file" -C /opt/node.new --strip-components=1 --no-same-owner
  rm -rf "$work" /opt/node
  mv /opt/node.new /opt/node
  for tool in /opt/node/bin/*; do
    ln -sf "$tool" /usr/local/bin/
  done
}

# Anthropic's stable channel. The app checks the signing key's fingerprint and writes it
# first. One copy of the binary, updated only through apt.
step_claude_code() {
  [ -s /etc/apt/keyrings/claude-code.asc ] || { echo "Claude Code's signing key is missing." >&2; exit 1; }
  echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main" > "$CLAUDE_LIST"
  update_claude_repo
  apt_install claude-code
}

step_upgrade_claude_code() {
  update_claude_repo
  apt-get install -y --only-upgrade claude-code
}

update_claude_repo() {
  apt-get update -o Dir::Etc::SourceList="$CLAUDE_LIST" -o Dir::Etc::SourceParts=- -o APT::Get::List-Cleanup=0
}

# The newest release of this fork with a server for this CPU, through the official installer.
# Keeps the version the server may still be running until the next update.
step_t3() {
  case "$(uname -m)" in
    aarch64) arch=arm64 ;;
    *) arch=x64 ;;
  esac
  if ! releases=$(curl -fsSL "https://api.github.com/repos/$RELEASE_REPO/releases?per_page=30"); then
    echo "Couldn't check $RELEASE_REPO for releases. Check the connection and try again." >&2
    exit 1
  fi
  # One field per line, so compact and pretty-printed JSON both list the newest release first.
  version=$(printf '%s\n' "$releases" | tr ',' '\n' \
    | sed -n "s/.*\"name\": *\"t3-\([^\"]*\)-linux-$arch\.tar\.gz\".*/\1/p" | head -n 1 || true)
  [ -n "$version" ] || { echo "No $RELEASE_REPO release has a Linux $arch server." >&2; exit 1; }
  previous=$(readlink -f "$T3_LINK" 2>/dev/null || true)
  if [ "$previous" = "$T3_VERSIONS/$version/t3" ]; then
    echo "T3 Code $version is already installed."
    return
  fi
  curl -fsSL https://t3.codes/install.sh \
    | T3CODE_VERSION="$version" T3CODE_RELEASE_BASE_URL="https://github.com/$RELEASE_REPO/releases/download" sh
  for dir in "$T3_VERSIONS"/*/; do
    dir=${dir%/}
    [ "$dir/t3" = "$T3_VERSIONS/$version/t3" ] || [ "$dir/t3" = "$previous" ] || rm -rf "$dir"
  done
}

# apt's indexes take about 150 MB, and every install or upgrade fetches them first.
step_cleanup() {
  apt-get clean
  rm -rf /var/lib/apt/lists/*
}

# key=value lines for the app.
step_status() {
  node=$(node --version 2>/dev/null || true)
  echo "node_version=${node#v}"
  echo "claude_version=$(claude --version 2>/dev/null | head -n 1 | cut -d ' ' -f 1 || true)"
  auth=$(claude auth status --json 2>/dev/null || true)
  case "$auth" in
    *'"loggedIn": true'* | *'"loggedIn":true'*) echo "claude_signed_in=true" ;;
    *) echo "claude_signed_in=false" ;;
  esac
  echo "claude_plan=$(printf '%s\n' "$auth" | sed -n 's/.*"subscriptionType": *"\([^"]*\)".*/\1/p' | head -n 1)"
  t3=$(readlink -f "$T3_LINK" 2>/dev/null || true)
  case "$t3" in
    */runtime/versions/*/t3) dir=${t3%/t3}; echo "t3_version=${dir##*/}" ;;
    *) echo "t3_version=" ;;
  esac
}

case "${1:-}" in
  packages) step_packages ;;
  node) step_node ;;
  claude-code) step_claude_code ;;
  upgrade-claude-code) step_upgrade_claude_code ;;
  t3) step_t3 ;;
  cleanup) step_cleanup ;;
  status) step_status ;;
  *) echo "Unknown step: ${1:-}" >&2; exit 2 ;;
esac
