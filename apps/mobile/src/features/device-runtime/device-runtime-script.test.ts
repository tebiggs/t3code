import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodeFS.readFileSync(
  NodePath.join(
    import.meta.dirname,
    "../../../modules/t3-device-runtime/android/src/main/assets/device-runtime-setup.sh",
  ),
  "utf8",
);

// Newest first, as GitHub lists them. The newest has no arm64 server.
const RELEASES = JSON.stringify([
  { tag_name: "v0.1.4", assets: [{ name: "t3-0.1.4-linux-x64.tar.gz" }] },
  {
    tag_name: "v0.1.3",
    assets: [{ name: "t3-0.1.3-linux-arm64.tar.gz" }, { name: "t3-0.1.3-linux-x64.tar.gz" }],
  },
]);

// Stands in for t3.codes/install.sh: unpacks nothing, but lays out the same directories.
const INSTALLER = `
echo "install $T3CODE_VERSION from $T3CODE_RELEASE_BASE_URL" >> "$STUB_LOG"
mkdir -p "$HOME/.t3/runtime/versions/$T3CODE_VERSION" "$HOME/.local/bin"
touch "$HOME/.t3/runtime/versions/$T3CODE_VERSION/t3"
ln -sfn "$HOME/.t3/runtime/versions/$T3CODE_VERSION/t3" "$HOME/.local/bin/t3"
`;

interface Guest {
  readonly home: string;
  readonly log: string;
  run(step: string): string;
  version(name: string): string;
  link(version: string): void;
  [Symbol.dispose](): void;
}

function writeExecutable(path: string, body: string) {
  NodeFS.writeFileSync(path, body, { mode: 0o755 });
}

function makeGuest(): Guest {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-device-runtime-"));
  const home = NodePath.join(root, "root");
  const bin = NodePath.join(root, "bin");
  const log = NodePath.join(root, "calls.log");
  NodeFS.mkdirSync(home);
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(log, "");
  NodeFS.writeFileSync(NodePath.join(root, "releases.json"), RELEASES);
  NodeFS.writeFileSync(NodePath.join(root, "installer.sh"), INSTALLER);
  writeExecutable(NodePath.join(bin, "uname"), "#!/bin/sh\necho aarch64\n");
  writeExecutable(
    NodePath.join(bin, "curl"),
    `#!/bin/sh
case "$*" in
  *api.github.com*) cat "${root}/releases.json" ;;
  *t3.codes/install.sh*) cat "${root}/installer.sh" ;;
  *) exit 22 ;;
esac
`,
  );
  writeExecutable(NodePath.join(bin, "node"), "#!/bin/sh\necho v24.22.1\n");
  writeExecutable(
    NodePath.join(bin, "claude"),
    `#!/bin/sh
case "$*" in
  --version) echo "2.1.308 (Claude Code)" ;;
  "auth status --json") echo '{"loggedIn": true, "subscriptionType": "max"}' ;;
esac
`,
  );
  const versions = NodePath.join(home, ".t3/runtime/versions");
  return {
    home,
    log,
    run(step) {
      return NodeChildProcess.execFileSync("bash", ["-s", "--", step], {
        input: SCRIPT,
        encoding: "utf8",
        env: { NODE_ENV: "test", HOME: home, PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log },
      });
    },
    version(name) {
      return NodePath.join(versions, name);
    },
    link(version) {
      NodeFS.mkdirSync(NodePath.join(versions, version), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(versions, version, "t3"), "");
      NodeFS.mkdirSync(NodePath.join(home, ".local/bin"), { recursive: true });
      NodeFS.rmSync(NodePath.join(home, ".local/bin/t3"), { force: true });
      NodeFS.symlinkSync(
        NodePath.join(versions, version, "t3"),
        NodePath.join(home, ".local/bin/t3"),
      );
    },
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("device-runtime-setup.sh", () => {
  it("installs the fork's newest release that has a server for this CPU", () => {
    using guest = makeGuest();
    guest.run("t3");
    expect(NodeFS.readFileSync(guest.log, "utf8")).toBe(
      "install 0.1.3 from https://github.com/tebiggs/t3code/releases/download\n",
    );
    expect(NodeFS.realpathSync(NodePath.join(guest.home, ".local/bin/t3"))).toBe(
      NodePath.join(guest.version("0.1.3"), "t3"),
    );
  });

  it("keeps the build the server may still run and deletes older ones", () => {
    using guest = makeGuest();
    guest.link("0.1.1");
    guest.link("0.1.2");
    guest.run("t3");
    expect(NodeFS.existsSync(guest.version("0.1.3"))).toBe(true);
    expect(NodeFS.existsSync(guest.version("0.1.2"))).toBe(true);
    expect(NodeFS.existsSync(guest.version("0.1.1"))).toBe(false);
  });

  it("downloads nothing when the newest build is already installed", () => {
    using guest = makeGuest();
    guest.link("0.1.3");
    expect(guest.run("t3")).toContain("T3 Code 0.1.3 is already installed.");
    expect(NodeFS.readFileSync(guest.log, "utf8")).toBe("");
  });

  it("reports versions and the Claude sign-in for the app", () => {
    using guest = makeGuest();
    guest.link("0.1.3");
    expect(guest.run("status").trim().split("\n")).toEqual([
      "node_version=24.22.1",
      "claude_version=2.1.308",
      "claude_signed_in=true",
      "claude_plan=max",
      "t3_version=0.1.3",
    ]);
  });
});
