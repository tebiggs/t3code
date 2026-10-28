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
  readonly requests: Received[];
  run(command: string, args: readonly string[], stdin?: string): Promise<Exit>;
}

// Stands in for AndroidBridge.kt, answering each request with `reply`.
async function startBridge(reply: (path: string | undefined) => unknown): Promise<Bridge> {
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

const succeed = () => ({ ok: true, result: null });

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
    expect(bridge.requests.map(({ path, body }) => ({ path, body }))).toEqual([
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

  it("fails with the reason on stderr", async () => {
    await using bridge = await startBridge(() => ({
      ok: false,
      error: "Only URLs are supported.",
    }));
    expect(await bridge.run("xdg-open", ["index.html"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "xdg-open: Only URLs are supported.\n",
    });
    expect(await bridge.run("termux-vibrate", ["-d", "soon"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "termux-vibrate: -d takes milliseconds\nUsage: termux-vibrate [-d ms]\n",
    });
    expect(bridge.requests.map(({ path }) => path)).toEqual(["/open-url"]);
  });

  it("says the bridge isn't running when there's no endpoint", async () => {
    await using bridge = await startBridge(succeed);
    NodeFS.rmSync(bridge.endpoint);
    const exit = await bridge.run("termux-open-url", ["https://example.com"]);
    expect(exit.code).toBe(1);
    expect(exit.stderr).toContain("Android bridge isn't running");
  });
});
