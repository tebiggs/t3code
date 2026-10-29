import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.join(
  import.meta.dirname,
  "../../../modules/t3-device-runtime/android/src/main/assets/android-bridge.mjs",
);
const TOKEN = "test-token";

interface Received {
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface Exit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Bridge extends AsyncDisposable {
  readonly endpoint: string;
  /** A scratch directory, by its real path. */
  readonly directory: string;
  readonly requests: Received[];
  run(command: string, args: readonly string[], stdin?: string): Promise<Exit>;
}

// Stands in for AndroidBridge.kt, answering each request with `reply`.
async function startBridge(
  reply: (path: string | undefined) => unknown = succeed,
): Promise<Bridge> {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-android-bridge-"));
  const endpoint = NodePath.join(directory, "endpoint");
  const requests: Received[] = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reply(request.url)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  NodeFS.writeFileSync(endpoint, `${address.port} ${TOKEN}\n`);
  return {
    endpoint,
    directory: NodeFS.realpathSync(directory),
    requests,
    run(command, args, stdin = "") {
      return new Promise((resolve) => {
        const child = NodeChildProcess.spawn(process.execPath, [SCRIPT, command, ...args], {
          env: { NODE_ENV: "test", T3_ANDROID_BRIDGE_ENDPOINT: endpoint },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(stdin);
      });
    },
    async [Symbol.asyncDispose]() {
      await new Promise((resolve) => server.close(resolve));
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function succeed() {
  return { ok: true, result: null };
}

const sent = (bridge: Bridge) => bridge.requests.map(({ path, body }) => ({ path, body }));

describe("android-bridge.mjs", () => {
  it("sends a notification's flags with its content from stdin", async () => {
    await using bridge = await startBridge(succeed);
    const exit = await bridge.run("termux-notification", ["-t", "Build", "--id=ci"], "Passed\n");
    expect(exit).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(bridge.requests).toEqual([
      {
        path: "/notification",
        authorization: `Bearer ${TOKEN}`,
        body: { id: "ci", title: "Build", content: "Passed" },
      },
    ]);
  });

  it("ends options at the first text argument and keeps clipboard text exact", async () => {
    await using bridge = await startBridge(succeed);
    await bridge.run("termux-toast", ["-s", "hello", "-s"]);
    await bridge.run("termux-clipboard-set", [], "line\n");
    expect(sent(bridge)).toEqual([
      { path: "/toast", body: { text: "hello -s", short: true } },
      { path: "/clipboard-set", body: { text: "line\n" } },
    ]);
  });

  it("prints results as Termux:API does", async () => {
    await using bridge = await startBridge((path) => {
      if (path === "/clipboard-get") return { ok: true, result: "copied" };
      if (path === "/battery-status") return { ok: true, result: { percentage: 80 } };
      return { ok: true, result: { notified: true, message: "Tap the notification." } };
    });
    expect((await bridge.run("termux-clipboard-get", [])).stdout).toBe("copied");
    expect((await bridge.run("termux-battery-status", [])).stdout).toBe(
      '{\n  "percentage": 80\n}\n',
    );
    expect(await bridge.run("xdg-open", ["https://example.com"])).toEqual({
      code: 0,
      stdout: "",
      stderr: "Tap the notification.\n",
    });
  });

  it("says what to allow when Android hides the Wi-Fi network's name", async () => {
    await using bridge = await startBridge(() => ({
      ok: true,
      result: { ssid: "<unknown ssid>", rssi: -50 },
    }));
    const { code, stderr } = await bridge.run("termux-wifi-connectioninfo", []);
    expect(code).toBe(0);
    expect(stderr).toContain("allow it in Settings > Agent access > Location");
  });

  it("fails with the reason on stderr", async () => {
    await using bridge = await startBridge(() => ({
      ok: false,
      error: "Only URLs are supported.",
    }));
    expect(await bridge.run("termux-open-url", ["index.html"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "termux-open-url: Only URLs are supported.\n",
    });
    expect(await bridge.run("termux-vibrate", ["-d", "soon"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "termux-vibrate: -d takes milliseconds\nUsage: termux-vibrate [-d ms]\n",
    });
    expect(bridge.requests.map(({ path }) => path)).toEqual(["/open-url"]);
  });

  it("opens files by their real path, which the app maps to its own, and URLs as given", async () => {
    await using bridge = await startBridge();
    const file = NodePath.join(bridge.directory, "report.pdf");
    const link = NodePath.join(bridge.directory, "latest.pdf");
    NodeFS.writeFileSync(file, "");
    NodeFS.symlinkSync(file, link);
    await bridge.run("termux-open", ["--send", link]);
    await bridge.run("xdg-open", ["https://example.com"]);
    expect(
      await bridge.run("termux-open", [NodePath.join(bridge.directory, "missing.pdf")]),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("no such file"),
    });
    expect(sent(bridge)).toEqual([
      { path: "/open", body: { path: file, send: true, chooser: false } },
      { path: "/open", body: { url: "https://example.com", send: false, chooser: false } },
    ]);
  });

  it("reads bundled short options as getopts does", async () => {
    await using bridge = await startBridge((path) =>
      path === "/media-scan"
        ? { ok: true, result: { files: ["/sdcard/a.jpg", "/sdcard/b.jpg"] } }
        : { ok: true, result: [] },
    );
    const missing = NodePath.join(bridge.directory, "deleted.jpg");
    const scan = await bridge.run("termux-media-scan", ["-rv", bridge.directory, missing]);
    await bridge.run("termux-sms-list", ["-cl5", "-t", "inbox"]);
    expect(scan.stdout).toBe("/sdcard/a.jpg\n/sdcard/b.jpg\nFinished scanning 2 file(s)\n");
    expect(sent(bridge)).toEqual([
      { path: "/media-scan", body: { paths: [bridge.directory, missing], recursive: true } },
      {
        path: "/sms-list",
        body: { limit: 5, offset: 0, type: "inbox", conversations: true },
      },
    ]);
  });

  it("converts Termux's units and refuses bad arguments before calling Android", async () => {
    await using bridge = await startBridge(() => ({ ok: true, result: "Recording started" }));
    const output = NodePath.join(bridge.directory, "memo.m4a");
    const recording = await bridge.run("termux-microphone-record", [
      "-f",
      output,
      "-l",
      "30",
      "-b",
      "128",
    ]);
    await bridge.run("termux-sms-send", ["-n", "555 0100, 555 0199", "on", "my", "way"]);
    const refused = [
      await bridge.run("termux-microphone-record", ["-i", "-q"]),
      await bridge.run("termux-volume", ["music", "loud"]),
      await bridge.run("termux-location", ["-p", "wifi"]),
      await bridge.run("termux-torch", ["bright"]),
    ];
    expect(recording.stdout).toBe("Recording started\n");
    expect(refused.map(({ code }) => code)).toEqual([1, 1, 1, 1]);
    expect(sent(bridge)).toEqual([
      {
        path: "/microphone-record",
        body: { action: "record", file: output, limit: 30_000, bitrate: 128_000 },
      },
      { path: "/sms-send", body: { recipients: ["555 0100", "555 0199"], text: "on my way" } },
    ]);
  });

  it("reads sensors once per -n and cleans up without calling Android", async () => {
    await using bridge = await startBridge(() => ({
      ok: true,
      result: { "BMI160 Accelerometer": { values: [0.1, 9.8, 0] } },
    }));
    const readings = await bridge.run("termux-sensor", ["-s", "accel", "-n", "2", "-d", "0"]);
    const cleanup = await bridge.run("termux-sensor", ["-c"]);
    const reading = JSON.stringify({ "BMI160 Accelerometer": { values: [0.1, 9.8, 0] } }, null, 2);
    expect(readings.stdout).toBe(`${reading}\n${reading}\n`);
    expect(cleanup.stdout).toBe("Sensor cleanup unnecessary\n");
    expect(sent(bridge)).toEqual([
      { path: "/sensor", body: { all: false, sensors: ["accel"] } },
      { path: "/sensor", body: { all: false, sensors: ["accel"] } },
    ]);
  });

  it("says the bridge isn't running when there's no endpoint", async () => {
    await using bridge = await startBridge(succeed);
    NodeFS.rmSync(bridge.endpoint);
    const exit = await bridge.run("termux-open-url", ["https://example.com"]);
    expect(exit.code).toBe(1);
    expect(exit.stderr).toContain("Android bridge isn't running");
  });
});
