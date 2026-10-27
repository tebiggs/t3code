# Installs the on-device runtime's tools. Runs inside its Ubuntu as proot's fake root, one
# step per run: bash -s -- <step>. Every step skips what is already in place.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_CHANNEL=https://nodejs.org/dist/latest-v24.x
CLAUDE_LIST=/etc/apt/sources.list.d/claude-code.list

apt_install() {
  apt-get install -y --no-install-recommends "$@"
}

# The base image has no CA certificates, so this first update uses the archive's plain-http
# mirrors; apt checks the signed indexes either way.
step_ca_certificates() {
  apt-get update
  apt_install ca-certificates
}

step_essentials() {
  apt_install curl git openssh-client ripgrep
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
  apt-get clean
}

step_upgrade_claude_code() {
  update_claude_repo
  apt-get install -y --only-upgrade claude-code
  apt-get clean
}

update_claude_repo() {
  apt-get update -o Dir::Etc::SourceList="$CLAUDE_LIST" -o Dir::Etc::SourceParts=- -o APT::Get::List-Cleanup=0
}

step_versions() {
  echo "node $(node --version)"
  claude --version
}

case "${1:-}" in
  ca-certificates) step_ca_certificates ;;
  essentials) step_essentials ;;
  node) step_node ;;
  claude-code) step_claude_code ;;
  upgrade-claude-code) step_upgrade_claude_code ;;
  versions) step_versions ;;
  *) echo "Unknown step: ${1:-}" >&2; exit 2 ;;
esac
