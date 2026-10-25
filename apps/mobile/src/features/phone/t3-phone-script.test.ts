import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { parsePhoneScriptStatus } from "./phone-setup";

const SCRIPT_PATH = NodePath.join(
  import.meta.dirname,
  "../../../modules/t3-termux/android/src/main/assets/t3-phone.sh",
);
const SCRIPT = NodeFS.readFileSync(SCRIPT_PATH, "utf8");
const HOST_BASH = NodeChildProcess.execFileSync("sh", ["-c", "command -v bash"], {
  encoding: "utf8",
}).trim();

// A fake Termux: $PREFIX/bin holds stubs that log their arguments, and the stub
// proot-distro runs guest commands on the host with a PATH of only the fake guest bin
// and the few host tools the guest scripts use, so host installs of claude or t3 stay out.
const PROOT_DISTRO_STUB = `#!/bin/sh
echo "proot-distro $*" >> "$STUB_LOG"
case "$1" in
  install)
    mkdir -p "$PREFIX/var/lib/proot-distro/containers/$2/rootfs/usr/bin"
    touch "$PREFIX/var/lib/proot-distro/containers/$2/rootfs/usr/bin/env"
    exit 0 ;;
  login)
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    shift
    case "$*" in
      *"/bin/bash -s"*) cat > "$STUB_DIR/guest-install.sh"; exit "\${STUB_GUEST_INSTALL_EXIT:-0}" ;;
    esac
    for arg do
      shift
      case "$arg" in
        PATH=*) arg="PATH=$GUEST_BIN:$GUEST_TOOLS" ;;
      esac
      set -- "$@" "$arg"
    done
    exec "$@" ;;
esac
`;

interface Sandbox {
  readonly root: string;
  readonly prefix: string;
  readonly home: string;
  readonly guestBin: string;
  readonly guestTools: string;
  readonly log: string;
  [Symbol.dispose](): void;
}

function makeSandbox(options: { readonly prootDistro: boolean }): Sandbox {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-phone-"));
  const prefix = NodePath.join(root, "usr");
  const home = NodePath.join(root, "home");
  const guestBin = NodePath.join(root, "guest-bin");
  const guestTools = NodePath.join(root, "guest-tools");
  const log = NodePath.join(root, "calls.log");
  for (const dir of [NodePath.join(prefix, "bin"), home, guestBin, guestTools]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  for (const tool of ["cat", "cut", "head", "readlink", "sed", "sh", "tr"]) {
    const hostPath = ["/usr/bin", "/bin"]
      .map((dir) => NodePath.join(dir, tool))
      .find((candidate) => NodeFS.existsSync(candidate));
    if (hostPath) NodeFS.symlinkSync(hostPath, NodePath.join(guestTools, tool));
  }
  NodeFS.writeFileSync(log, "");
  const logStub = (name: string, body = "") =>
    writeExecutable(
      NodePath.join(prefix, "bin", name),
      `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}`,
    );
  // Refuses to connect, like curl with nothing listening on the port. Not logged: it only probes.
  writeExecutable(NodePath.join(prefix, "bin", "curl"), "#!/bin/sh\nexit 7\n");
  for (const name of [
    "pkg",
    "am",
    "termux-setup-storage",
    "termux-wake-lock",
    "termux-wake-unlock",
    "sleep",
  ]) {
    logStub(name);
  }
  if (options.prootDistro) {
    writeExecutable(NodePath.join(prefix, "bin", "proot-distro"), PROOT_DISTRO_STUB);
  }
  return {
    root,
    prefix,
    home,
    guestBin,
    guestTools,
    log,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

function writeExecutable(path: string, contents: string) {
  NodeFS.writeFileSync(path, contents, { mode: 0o755 });
}

// Stands in for /storage/emulated/0 being readable, which is how the script tells storage
// access was granted.
function allowStorage(sandbox: Sandbox) {
  NodeFS.mkdirSync(NodePath.join(sandbox.root, "shared"));
}

/** Field 22 of /proc/<pid>/stat, the start time t3-phone records to recognize its server. */
function processStartTime(pid: number): string {
  const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? "";
}

function installUbuntu(sandbox: Sandbox) {
  const rootfs = NodePath.join(sandbox.prefix, "var/lib/proot-distro/installed-rootfs/ubuntu");
  NodeFS.mkdirSync(NodePath.join(rootfs, "usr/bin"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(rootfs, "usr/bin/env"), "");
  return rootfs;
}

// The guest's claude is the native installer's symlink into a versions directory.
function installGuestClaude(sandbox: Sandbox, authStatus: string) {
  const versions = NodePath.join(sandbox.root, "claude/versions");
  NodeFS.mkdirSync(versions, { recursive: true });
  const binary = NodePath.join(versions, "2.1.310");
  writeExecutable(
    binary,
    `#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then cat <<'EOF'\n${authStatus}\nEOF\nfi\n`,
  );
  NodeFS.symlinkSync(binary, NodePath.join(sandbox.guestBin, "claude"));
}

function run(sandbox: Sandbox, args: ReadonlyArray<string>, env: Record<string, string> = {}) {
  const result = NodeChildProcess.spawnSync("bash", ["-c", SCRIPT, "t3-phone", ...args], {
    encoding: "utf8",
    env: {
      NODE_ENV: "test",
      PATH: `${NodePath.join(sandbox.prefix, "bin")}:/usr/bin:/bin`,
      PREFIX: sandbox.prefix,
      HOME: sandbox.home,
      STUB_LOG: sandbox.log,
      STUB_DIR: sandbox.root,
      GUEST_BIN: sandbox.guestBin,
      GUEST_TOOLS: sandbox.guestTools,
      T3_PHONE_SHARED_STORAGE: NodePath.join(sandbox.root, "shared"),
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    calls: NodeFS.readFileSync(sandbox.log, "utf8").split("\n").filter(Boolean),
  };
}

describe("t3-phone status", () => {
  it("reports a Termux without proot-distro as needing everything", () => {
    using sandbox = makeSandbox({ prootDistro: false });
    const result = run(sandbox, ["status"]);

    expect(result.status).toBe(0);
    expect(parsePhoneScriptStatus(result.stdout)).toEqual({
      launcherVersion: null,
      port: 3773,
      storage: false,
      serverRunning: false,
      install: null,
      installRunning: false,
      prootDistro: false,
      ubuntu: false,
      environmentId: null,
      claudeVersion: null,
      claudeSignedIn: false,
      claudePlan: null,
      t3Version: null,
    });
  });

  it("detects a hand-made setup with Claude signed in and no T3 Code", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    allowStorage(sandbox);
    installGuestClaude(
      sandbox,
      '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}',
    );

    const status = parsePhoneScriptStatus(run(sandbox, ["status"]).stdout);

    expect(status).toMatchObject({
      storage: true,
      prootDistro: true,
      ubuntu: true,
      claudeVersion: "2.1.310",
      claudeSignedIn: true,
      claudePlan: "max",
      t3Version: null,
    });
  });

  it("reports Claude as signed out when auth status says so", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    installGuestClaude(sandbox, '{\n  "loggedIn": false\n}');

    expect(parsePhoneScriptStatus(run(sandbox, ["status"]).stdout)).toMatchObject({
      claudeVersion: "2.1.310",
      claudeSignedIn: false,
    });
  });
});

describe("t3-phone install", () => {
  it("installs everything on a fresh Termux and saves itself as t3-phone", () => {
    using sandbox = makeSandbox({ prootDistro: false });
    // pkg install proot-distro makes the real stub appear.
    writeExecutable(
      NodePath.join(sandbox.prefix, "bin", "pkg"),
      `#!/bin/sh\necho "pkg $*" >> "$STUB_LOG"\nif [ "$1" = install ]; then cp "$STUB_DIR/proot-distro" "$PREFIX/bin/proot-distro"; fi\n`,
    );
    writeExecutable(NodePath.join(sandbox.root, "proot-distro"), PROOT_DISTRO_STUB);

    const result = run(sandbox, ["install", "com.t3tools.t3code/.MainActivity", "Tim's Z Fold5"]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "termux-wake-lock ",
      "termux-setup-storage ",
      "pkg upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold",
      "pkg install -y proot-distro",
      "proot-distro install ubuntu",
      expect.stringMatching(
        /^proot-distro login ubuntu -- .* env MODE=install DEVICE_NAME=Tim's Z Fold5 RELEASE_REPO=tebiggs\/t3code \/bin\/bash -s$/,
      ),
      "sleep 2",
      "am start -n com.t3tools.t3code/.MainActivity",
      "termux-wake-unlock ",
    ]);
    const launcher = NodeFS.readFileSync(NodePath.join(sandbox.prefix, "bin", "t3-phone"), "utf8");
    expect(launcher).toBe(`#!${sandbox.prefix}/bin/bash\n${SCRIPT}\n`);
    expect(NodeFS.readFileSync(NodePath.join(sandbox.root, "guest-install.sh"), "utf8")).toContain(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    expect(parsePhoneScriptStatus(run(sandbox, ["status"]).stdout)).toMatchObject({
      launcherVersion: 1,
      install: { status: "done", step: 4, total: 4, running: false },
    });
  });

  it("takes over a lock path left as a directory by a dead installer", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    allowStorage(sandbox);
    NodeFS.mkdirSync(NodePath.join(sandbox.home, ".t3-phone/install.lock"), { recursive: true });

    const result = run(sandbox, ["install"]);

    expect(result.status).toBe(0);
    expect(result.calls).toContainEqual(
      expect.stringMatching(/^proot-distro login ubuntu -- .* \/bin\/bash -s$/),
    );
    expect(NodeFS.existsSync(NodePath.join(sandbox.home, ".t3-phone/install.lock"))).toBe(false);
  });

  it("reports a running installer without entering Ubuntu", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    NodeFS.mkdirSync(NodePath.join(sandbox.home, ".t3-phone"), { recursive: true });
    NodeFS.symlinkSync(
      `${process.pid}:${processStartTime(process.pid)}`,
      NodePath.join(sandbox.home, ".t3-phone/install.lock"),
    );
    NodeFS.writeFileSync(
      NodePath.join(sandbox.home, ".t3-phone/install.state"),
      "status=running\nstep=2\ntotal=4\nmessage=Ubuntu\n",
    );

    const result = run(sandbox, ["status"]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(parsePhoneScriptStatus(result.stdout)).toMatchObject({
      install: { status: "running", step: 2, total: 4, message: "Ubuntu", running: true },
      installRunning: true,
    });
  });

  it("refuses to start a second installer while one is running", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    // This test's own process stands in for a live installer.
    NodeFS.mkdirSync(NodePath.join(sandbox.home, ".t3-phone"), { recursive: true });
    NodeFS.symlinkSync(
      `${process.pid}:${processStartTime(process.pid)}`,
      NodePath.join(sandbox.home, ".t3-phone/install.lock"),
    );

    const result = run(sandbox, ["install"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Setup is already running");
    expect(result.calls).toEqual([]);
    expect(parsePhoneScriptStatus(run(sandbox, ["status"]).stdout).installRunning).toBe(true);
  });

  it("skips finished parts of an existing setup", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    allowStorage(sandbox);

    const result = run(sandbox, ["install"]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "termux-wake-lock ",
      expect.stringMatching(/^proot-distro login ubuntu -- .* \/bin\/bash -s$/),
      "termux-wake-unlock ",
    ]);
  });

  it("stops before saving t3-phone or returning when the Ubuntu part fails", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    allowStorage(sandbox);

    const result = run(sandbox, ["install", "com.t3tools.t3code/.MainActivity"], {
      STUB_GUEST_INSTALL_EXIT: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Setup stopped: Installing inside Ubuntu failed.");
    expect(parsePhoneScriptStatus(run(sandbox, ["status"]).stdout)).toMatchObject({
      install: { status: "failed", step: 3, message: "Installing inside Ubuntu failed." },
      installRunning: false,
    });
    expect(NodeFS.existsSync(NodePath.join(sandbox.prefix, "bin", "t3-phone"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("am "))).toBe(false);
    expect(result.calls.at(-1)).toBe("termux-wake-unlock ");
  });
});

describe("t3-phone pair", () => {
  it("prints only the pairing URL from t3 pair", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    writeExecutable(
      NodePath.join(sandbox.guestBin, "t3"),
      `#!/bin/sh\nprintf 'Pairing with phone (http://127.0.0.1:3773).\\n\\n##QR##\\n\\nPairing URL: http://127.0.0.1:3773/pair#token=abc\\nToken: abc\\n'\n`,
    );

    const result = run(sandbox, ["pair"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("pairing_url=http://127.0.0.1:3773/pair#token=abc\n");
  });

  it("fails without a pairing URL", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    writeExecutable(
      NodePath.join(sandbox.guestBin, "t3"),
      "#!/bin/sh\necho 'No running T3 Code server found.'\nexit 1\n",
    );

    expect(run(sandbox, ["pair"]).status).toBe(1);
  });
});

describe("t3-phone serve and stop", () => {
  const stateDir = (sandbox: Sandbox) => NodePath.join(sandbox.home, ".t3-phone");

  /** Writes serve.lock as if `pid` were the running supervisor. */
  function holdServeLock(sandbox: Sandbox, identity: string) {
    NodeFS.mkdirSync(stateDir(sandbox), { recursive: true });
    NodeFS.symlinkSync(identity, NodePath.join(stateDir(sandbox), "serve.lock"));
  }

  function spawnLongRunning(ignoreTerm: boolean) {
    const child = NodeChildProcess.spawn(
      "sh",
      ["-c", ignoreTerm ? "trap '' TERM; exec sleep 600" : "exec sleep 600"],
      { stdio: "ignore" },
    );
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("exit", (_code, signal) => resolve(signal)),
    );
    return { child, pid: child.pid ?? 0, exited };
  }

  it("supervises the server and gives back its locks when it exits", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    writeExecutable(NodePath.join(sandbox.guestBin, "t3"), '#!/bin/sh\necho "t3 $*"\n');

    const result = run(sandbox, ["serve"]);

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "termux-wake-lock ",
      expect.stringMatching(
        /^proot-distro login ubuntu -- .* t3 serve --host 127\.0\.0\.1 --port 3773$/,
      ),
      "termux-wake-unlock ",
    ]);
    expect(NodeFS.readFileSync(NodePath.join(stateDir(sandbox), "server.log"), "utf8")).toBe(
      "t3 serve --host 127.0.0.1 --port 3773\n\nT3 Code exited with status 0.\n",
    );
    expect(NodeFS.existsSync(NodePath.join(stateDir(sandbox), "serve.lock"))).toBe(false);
  });

  it("starts no second server while one is running or starting", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    holdServeLock(sandbox, `${process.pid}:${processStartTime(process.pid)}`);

    const result = run(sandbox, ["serve"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("T3 Code is already running or starting.\n");
    expect(result.calls).toEqual([]);
  });

  it("leaves a reused pid alone", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    // This test's own process, recorded with a start time it never had.
    holdServeLock(sandbox, `${process.pid}:1`);

    const result = run(sandbox, ["stop"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("T3 Code wasn't running.\n");
  });

  it("stops the supervisor and reports success only once it is gone", async () => {
    using sandbox = makeSandbox({ prootDistro: true });
    const supervisor = spawnLongRunning(false);
    holdServeLock(sandbox, `${supervisor.pid}:${processStartTime(supervisor.pid)}`);

    const result = run(sandbox, ["stop"]);

    expect(result).toMatchObject({ status: 0, stdout: "Stopped T3 Code.\n" });
    expect(await supervisor.exited).toBe("SIGTERM");
  });

  it("reports failure and keeps the lock when the server doesn't stop", async () => {
    using sandbox = makeSandbox({ prootDistro: true });
    const supervisor = spawnLongRunning(true);
    const identity = `${supervisor.pid}:${processStartTime(supervisor.pid)}`;
    holdServeLock(sandbox, identity);

    const result = run(sandbox, ["stop"]);
    supervisor.child.kill("SIGKILL");

    expect(result).toMatchObject({
      status: 1,
      stdout: "T3 Code didn't stop within 10 seconds.\n",
    });
    expect(NodeFS.readlinkSync(NodePath.join(stateDir(sandbox), "serve.lock"))).toBe(identity);
    expect(await supervisor.exited).toBe("SIGKILL");
  });
});

describe("t3-phone update", () => {
  const RELEASES = (arm64: boolean) => `[
  {
    "tag_name": "v0.1.3-nightly.20261026.25",
    "assets": [
      {
        "name": "t3-0.1.3-nightly.20261026.25-linux-x64.tar.gz",
${arm64 ? '      },\n      {\n        "name": "t3-0.1.3-nightly.20261026.25-linux-arm64.tar.gz",' : ""}
      }
    ]
  }
]`;

  /** Runs the Ubuntu half of `t3-phone update` on the host, on an arm64 phone. */
  function runGuestUpdate(sandbox: Sandbox, releases: string | null) {
    expect(run(sandbox, ["update"]).calls).toEqual([
      expect.stringMatching(
        /^proot-distro login ubuntu -- .* env MODE=update DEVICE_NAME= RELEASE_REPO=tebiggs\/t3code \/bin\/bash -s$/,
      ),
    ]);
    if (releases !== null) {
      NodeFS.writeFileSync(NodePath.join(sandbox.root, "releases.json"), releases);
    }
    writeExecutable(NodePath.join(sandbox.guestBin, "uname"), "#!/bin/sh\necho aarch64\n");
    for (const name of ["claude", "t3"]) {
      writeExecutable(NodePath.join(sandbox.guestBin, name), "#!/bin/sh\n");
    }
    // The last argument is the URL: the release list, or an installer that logs its settings.
    writeExecutable(
      NodePath.join(sandbox.guestBin, "curl"),
      `#!/bin/sh
for url; do :; done
case "$url" in
  *api.github.com*) [ -f "$STUB_DIR/releases.json" ] || exit 22; cat "$STUB_DIR/releases.json" ;;
  *install.sh) echo 'echo "installer version=$T3CODE_VERSION base=$T3CODE_RELEASE_BASE_URL channel=$T3CODE_CHANNEL" >> "$STUB_LOG"' ;;
esac
`,
    );
    // Spawned by absolute path: the guest PATH below has no bash on it.
    const result = NodeChildProcess.spawnSync(
      HOST_BASH,
      [NodePath.join(sandbox.root, "guest-install.sh")],
      {
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          PATH: `${sandbox.guestBin}:${sandbox.guestTools}`,
          MODE: "update",
          RELEASE_REPO: "tebiggs/t3code",
          STUB_LOG: sandbox.log,
          STUB_DIR: sandbox.root,
        },
      },
    );
    return { status: result.status, calls: NodeFS.readFileSync(sandbox.log, "utf8") };
  }

  it("installs the fork's newest server for this CPU", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);

    const result = runGuestUpdate(sandbox, RELEASES(true));

    expect(result.status).toBe(0);
    expect(result.calls).toContain(
      "installer version=0.1.3-nightly.20261026.25 base=https://github.com/tebiggs/t3code/releases/download channel=\n",
    );
  });

  it("falls back to upstream's nightly when the fork has no server for this CPU", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);

    const result = runGuestUpdate(sandbox, RELEASES(false));

    expect(result.status).toBe(0);
    expect(result.calls).toContain("installer version= base= channel=nightly\n");
  });

  it("takes the newest release when the API answers in compact JSON", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);
    const compact = JSON.stringify(
      ["0.2.0-nightly.20261027.30", "0.1.3-nightly.20261026.25"].map((version) => ({
        tag_name: `v${version}`,
        assets: [{ name: `t3-${version}-linux-arm64.tar.gz` }],
      })),
    );

    expect(runGuestUpdate(sandbox, compact).calls).toContain(
      "installer version=0.2.0-nightly.20261027.30 ",
    );
  });

  it("keeps the installed server when GitHub can't be reached", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    installUbuntu(sandbox);

    const result = runGuestUpdate(sandbox, null);

    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("installer");
  });

  it("refuses a second update while one is running", () => {
    using sandbox = makeSandbox({ prootDistro: true });
    NodeFS.mkdirSync(NodePath.join(sandbox.home, ".t3-phone"), { recursive: true });
    NodeFS.symlinkSync(
      `${process.pid}:${processStartTime(process.pid)}`,
      NodePath.join(sandbox.home, ".t3-phone/update.lock"),
    );

    const result = run(sandbox, ["update"]);

    expect(result).toMatchObject({
      status: 1,
      stdout: "An update is already running.\n",
      calls: [],
    });
  });
});
