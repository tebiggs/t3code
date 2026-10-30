import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { buildRemoteOpenUrl, EnvironmentId, type RemoteOpenTarget } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveConnectedRoute, resolveRemoteOpenState } from "./remoteOpen";

const environmentId = EnvironmentId.make("environment-1");

const primaryTarget = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({
    environmentId,
    label: "sol",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace("http", "ws"),
  });

const TAILSCALE_TARGETS = [
  { kind: "tailscale", host: "sol.tail1234.ts.net" },
  { kind: "mdns", host: "sol.local" },
] as const;

describe("resolveRemoteOpenState", () => {
  it("keeps exec behavior for a loopback primary target", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://127.0.0.1:8000"),
        sshTarget: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("uses deep links for a primary target reached over the network", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("https://sol.tail1234.ts.net"),
        sshTarget: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "tailscale", host: "sol.tail1234.ts.net" },
    });
  });

  it("keeps exec behavior for the desktop app's own primary even on a NAT URL", () => {
    // wsl-only binds the desktop-owned primary to its WSL2 NAT address.
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://172.29.112.1:14369"),
        sshTarget: null,
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("leaves a bare desktop SSH alias for the editor to resolve through SSH config", () => {
    const state = resolveRemoteOpenState({
      target: new SshConnectionTarget({ environmentId, label: "sol", connectionId: "ssh-1" }),
      sshTarget: { alias: "sol", username: null },
      isDesktopRenderer: true,
      remoteOpenTargets: [
        { kind: "tailscale", host: "sol.tail1234.ts.net", username: "server-user" },
      ],
    });
    expect(state).toEqual({ mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } });
    if (state.mode !== "remote-links") throw new Error("Expected a remote link");
    expect(
      buildRemoteOpenUrl({ editor: "vscode", ...state.host, absolutePath: "/work/project" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "zed", ...state.host, absolutePath: "/work/project" }),
    ).toBe("zed://ssh/sol/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "idea", ...state.host, absolutePath: "/work/project" }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=sol&launchIde=true&ideHint=IU&projectHint=%2Fwork%2Fproject",
    );
  });

  it.each([
    { alias: "server", username: "admin-user" },
    { alias: "admin-user@server", username: null },
    { alias: "old-user@server", username: "admin-user" },
    { alias: "admin-user@server", username: "" },
    { alias: "admin-user@server", username: "  " },
  ])("keeps one login username in editor links for $alias (username: '$username')", (sshTarget) => {
    const state = resolveRemoteOpenState({
      target: new SshConnectionTarget({ environmentId, label: "server", connectionId: "ssh-1" }),
      sshTarget,
      isDesktopRenderer: true,
      remoteOpenTargets: TAILSCALE_TARGETS,
    });
    expect(state.mode).toBe("remote-links");
    if (state.mode !== "remote-links") throw new Error("Expected a remote link");
    expect(
      buildRemoteOpenUrl({ editor: "vscode", ...state.host, absolutePath: "/work/project" }),
    ).toBe("vscode://vscode-remote/ssh-remote+admin-user%40server/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "zed", ...state.host, absolutePath: "/work/project" }),
    ).toBe("zed://ssh/admin-user@server/work/project");
    expect(
      buildRemoteOpenUrl({ editor: "idea", ...state.host, absolutePath: "/work/project" }),
    ).toBe(
      "jetbrains://gateway/ssh/environment?h=server&launchIde=true&ideHint=IU&projectHint=%2Fwork%2Fproject&u=admin-user",
    );
  });

  it("uses the advertised login username in editor links over a relay", () => {
    const state = resolveRemoteOpenState({
      target: new RelayConnectionTarget({ environmentId, label: "server" }),
      sshTarget: null,
      isDesktopRenderer: false,
      remoteOpenTargets: [
        { kind: "tailscale", host: "server.tail1234.ts.net", username: "admin-user" },
      ],
    });
    expect(state.mode).toBe("remote-links");
    if (state.mode !== "remote-links") throw new Error("Expected a remote link");
    expect(
      buildRemoteOpenUrl({ editor: "cursor", ...state.host, absolutePath: "/work/project" }),
    ).toBe("cursor://vscode-remote/ssh-remote+admin-user%40server.tail1234.ts.net/work/project");
  });

  describe("connection host", () => {
    const SSHD_TARGETS = [
      { kind: "tailscale", host: "sol.tail1234.ts.net", username: "dev", sshd: true },
      { kind: "mdns", host: "sol.local", username: "dev", sshd: true },
    ] as const;
    const TAILSCALE_ONLY_TARGETS = [
      { kind: "tailscale", host: "sol.tail1234.ts.net", username: "dev" },
    ] as const;

    const bearerRoute = (httpBaseUrl: string, network?: "tailscale") => ({
      target: new BearerConnectionTarget({
        environmentId,
        label: "sol",
        connectionId: httpBaseUrl,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: httpBaseUrl,
          environmentId,
          label: "sol",
          httpBaseUrl,
          wsBaseUrl: httpBaseUrl.replace("http", "ws"),
          ...(network === undefined ? {} : { network }),
        }),
      ),
    });
    const resolveOverBearer = (
      httpBaseUrl: string,
      remoteOpenTargets: ReadonlyArray<RemoteOpenTarget> = SSHD_TARGETS,
    ) => {
      const route = bearerRoute(httpBaseUrl);
      return resolveRemoteOpenState({
        target: route.target,
        sshTarget: null,
        isDesktopRenderer: true,
        remoteOpenTargets,
        connectedRoute: route,
      });
    };

    it("builds the Remote-SSH link from the LAN address the client reached", () => {
      const state = resolveOverBearer("http://192.168.1.153:3773");
      if (state.mode !== "remote-links") throw new Error("Expected a remote link");
      expect(state.host).toEqual({ kind: "connection", host: "192.168.1.153", username: "dev" });
      expect(
        buildRemoteOpenUrl({ editor: "vscode", ...state.host, absolutePath: "/work/project" }),
      ).toBe("vscode://vscode-remote/ssh-remote+dev%40192.168.1.153/work/project");
    });

    it.each([
      "http://10.0.0.5:3773",
      "http://172.16.0.5:3773",
      "http://sol.local:3773",
      "http://sol:3773",
      "https://sol.tail1234.ts.net",
      "http://100.64.1.2:3773",
    ])("uses a direct route's host: %s", (httpBaseUrl) => {
      expect(resolveOverBearer(httpBaseUrl)).toEqual({
        mode: "remote-links",
        host: { kind: "connection", host: new URL(httpBaseUrl).hostname, username: "dev" },
      });
    });

    it.each([
      "https://t3.example.com",
      "https://sol-tunnel.trycloudflare.com",
      "http://8.8.8.8:3773",
      "http://127.0.0.1:3773",
      "http://localhost:3773",
      "http://sol.localhost:3773",
      "http://0.0.0.0:3773",
      "http://[::1]:3773",
      "http://[fd12:3456::1]:3773",
      "http://[fe80::1]:3773",
    ])("keeps the advertised host for a route that cannot serve SSH: %s", (httpBaseUrl) => {
      expect(resolveOverBearer(httpBaseUrl)).toEqual({
        mode: "remote-links",
        host: SSHD_TARGETS[0],
      });
    });

    it("keeps the tailnet name when only Tailscale SSH serves the host", () => {
      expect(resolveOverBearer("http://192.168.1.153:3773", TAILSCALE_ONLY_TARGETS)).toEqual({
        mode: "remote-links",
        host: TAILSCALE_ONLY_TARGETS[0],
      });
    });

    it("omits the username when the server advertises none", () => {
      expect(
        resolveOverBearer("http://192.168.1.153:3773", [
          { kind: "mdns", host: "sol.local", sshd: true },
        ]),
      ).toEqual({
        mode: "remote-links",
        host: { kind: "connection", host: "192.168.1.153" },
      });
    });

    it("covers a browser served by the server over the LAN", () => {
      const target = primaryTarget("http://192.168.1.153:3773");
      expect(
        resolveRemoteOpenState({
          target,
          sshTarget: null,
          isDesktopRenderer: false,
          remoteOpenTargets: SSHD_TARGETS,
          connectedRoute: { target, profile: Option.none() },
        }),
      ).toEqual({
        mode: "remote-links",
        host: { kind: "connection", host: "192.168.1.153", username: "dev" },
      });
    });

    it("lets an SSH profile alias win over a direct route", () => {
      const route = bearerRoute("http://192.168.1.153:3773");
      expect(
        resolveRemoteOpenState({
          target: new SshConnectionTarget({ environmentId, label: "sol", connectionId: "ssh-1" }),
          sshTarget: { alias: "sol", username: null },
          isDesktopRenderer: true,
          remoteOpenTargets: SSHD_TARGETS,
          connectedRoute: route,
        }),
      ).toEqual({ mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } });
    });

    it("keeps the advertised host over a relay", () => {
      const target = new RelayConnectionTarget({ environmentId, label: "sol" });
      expect(
        resolveRemoteOpenState({
          target,
          sshTarget: null,
          isDesktopRenderer: false,
          remoteOpenTargets: SSHD_TARGETS,
          connectedRoute: { target, profile: Option.none() },
        }),
      ).toEqual({ mode: "remote-links", host: SSHD_TARGETS[0] });
    });

    it("follows the route the client is connected on, not the first saved one", () => {
      const lan = bearerRoute("http://192.168.1.153:3773");
      const tailnet = bearerRoute("https://sol.tail1234.ts.net");
      const entry = {
        target: lan.target,
        profile: lan.profile,
        alternateRoutes: [tailnet],
        enabled: true,
      };
      const prepared = {
        environmentId,
        label: "sol",
        httpBaseUrl: "https://sol.tail1234.ts.net",
        socketUrl: "wss://sol.tail1234.ts.net",
        httpAuthorization: null,
      };
      expect(resolveConnectedRoute(entry, { ...prepared, target: tailnet.target })).toBe(tailnet);
      expect(resolveConnectedRoute(entry, null).target).toBe(lan.target);
    });
  });

  it("reports unavailable when a remote environment advertises no hosts", () => {
    for (const remoteOpenTargets of [[], undefined] as const) {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: "sol" }),
          sshTarget: null,
          isDesktopRenderer: false,
          remoteOpenTargets,
        }),
      ).toEqual({ mode: "remote-unavailable" });
    }
  });
});

describe("buildRemoteOpenUrl", () => {
  it("roots Windows paths", () => {
    expect(
      buildRemoteOpenUrl({ editor: "vscode", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo");
  });

  it("drops the Windows drive letter for Zed", () => {
    expect(
      buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("zed://ssh/sol/Users/theo");
    expect(buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "/C:/project" })).toBe(
      "zed://ssh/sol/C%3A/project",
    );
  });

  it("adds a file position only for confirmed VS Code-family file targets", () => {
    const targets = [
      ["vscode", true, "vscode://vscode-remote/ssh-remote+sol/tmp/my%20file.md:1:1"],
      ["cursor", true, "cursor://vscode-remote/ssh-remote+sol/tmp/my%20file.md:1:1"],
      ["vscode", false, "vscode://vscode-remote/ssh-remote+sol/tmp/my%20file.md"],
      ["vscode", undefined, "vscode://vscode-remote/ssh-remote+sol/tmp/my%20file.md"],
      ["zed", true, "zed://ssh/sol/tmp/my%20file.md"],
      [
        "pycharm",
        true,
        "jetbrains://gateway/ssh/environment?h=sol&launchIde=true&ideHint=PY&projectHint=%2Ftmp%2Fmy+file.md",
      ],
    ] as const;

    for (const [editor, isFile, expected] of targets) {
      expect(
        buildRemoteOpenUrl({
          editor,
          host: "sol",
          absolutePath: "/tmp/my file.md",
          ...(isFile === undefined ? {} : { isFile }),
        }),
        `${editor}, isFile=${isFile}`,
      ).toBe(expected);
    }
  });
});
