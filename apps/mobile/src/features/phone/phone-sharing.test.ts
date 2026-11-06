import { describe, expect, it } from "@effect/vitest";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  phoneSharingFromLinkState,
  setServerSharingMode,
  stopServerSharing,
} from "./phone-sharing";

const connection = {
  environmentId: EnvironmentId.make("phone"),
  environmentLabel: "Phone",
  pairingUrl: "http://127.0.0.1:3774/",
  displayUrl: "http://127.0.0.1:3774/",
  httpBaseUrl: "http://127.0.0.1:3774/",
  wsBaseUrl: "ws://127.0.0.1:3774/",
  bearerToken: "local-bearer",
};

const linkState = {
  sharingModeChangePending: false,
  linked: false,
  linkRevoked: false,
  cloudUserId: null,
  relayUrl: null,
  relayIssuer: null,
  managedTunnelActive: false,
  publishAgentActivity: false,
  holdWebhooksWhileOffline: false,
};

function layerServer(
  failing: ReadonlySet<string> = new Set(),
  failingOnce = new Set<string>(),
  holdUnlink?: { readonly reached: () => void; readonly released: Promise<void> },
) {
  const requests: Array<string> = [];
  const respond = (path: string) => {
    if (failing.has(path)) return Response.json({ error: "no" }, { status: 500 });
    if (failingOnce.delete(path)) return Response.json({ error: "no" }, { status: 500 });
    if (path === "/api/connect/unlink") {
      return Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } });
    }
    if (path === "/api/auth/clients/revoke-others") return Response.json({ revokedCount: 2 });
    if (path === "/api/connect/sharing-mode") return Response.json(linkState);
    return Response.json({ revoked: true });
  };
  const layer = layerRemoteHttpClient((input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (holdUnlink && path === "/api/connect/unlink") {
      holdUnlink.reached();
      return holdUnlink.released.then(() => respond(path));
    }
    return Promise.resolve(respond(path));
  });
  return { requests, layer };
}

describe("phoneSharingFromLinkState", () => {
  it("reads a shared server with no stored mode as Full control, which is what it grants", () => {
    const shared = { ...linkState, linked: true, cloudUserId: "user_a" };
    expect(phoneSharingFromLinkState(shared)).toMatchObject({
      mode: "full-control",
      modeChangePending: false,
    });
    expect(
      phoneSharingFromLinkState({
        ...shared,
        sharingMode: "view-only",
        sharingModeChangePending: true,
      }),
    ).toMatchObject({ mode: "view-only", modeChangePending: true });
  });

  it("spots a server from before sharing modes by what its link state leaves out", () => {
    const { sharingModeChangePending: _absent, ...older } = linkState;
    expect(phoneSharingFromLinkState(older)).toEqual({ shared: false, modesUnsupported: true });
    expect(phoneSharingFromLinkState(linkState)).toEqual({ shared: false });
  });

  it("counts anything the server still holds as shared, so Off can clear it", () => {
    expect(phoneSharingFromLinkState(linkState).shared).toBe(false);
    expect(
      phoneSharingFromLinkState({
        ...linkState,
        linked: true,
        linkRevoked: true,
        cloudUserId: "user_a",
        managedTunnelActive: true,
      }),
    ).toEqual({
      shared: true,
      revoked: true,
      cloudUserId: "user_a",
      reachability: null,
      mode: "full-control",
      modeChangePending: false,
    });
    expect(phoneSharingFromLinkState({ ...linkState, managedTunnelActive: true }).shared).toBe(
      true,
    );
  });
});

describe("stopServerSharing", () => {
  it.effect("signs others out around stopping the tunnel, then revokes pairing links", () => {
    const server = layerServer();
    return Effect.gen(function* () {
      yield* stopServerSharing(connection, Effect.succeed(["link-1"]));
      expect(server.requests).toEqual([
        "/api/auth/clients/revoke-others",
        "/api/connect/unlink",
        "/api/auth/clients/revoke-others",
        "/api/auth/pairing-links/revoke",
      ]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("still stops the tunnel when the first sign-out fails", () => {
    const server = layerServer(new Set(), new Set(["/api/auth/clients/revoke-others"]));
    return Effect.gen(function* () {
      yield* stopServerSharing(connection, Effect.succeed([]));
      expect(server.requests).toEqual([
        "/api/auth/clients/revoke-others",
        "/api/connect/unlink",
        "/api/auth/clients/revoke-others",
      ]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("waits out the 30 seconds the tunnel takes to drain a connection", () => {
    let reached = () => {};
    const unlinkReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = layerServer(new Set(), new Set(), { reached, released });
    return Effect.gen(function* () {
      const stop = yield* stopServerSharing(connection, Effect.succeed([])).pipe(Effect.forkChild);
      yield* Effect.promise(() => unlinkReached);
      yield* TestClock.adjust("30 seconds");
      release();
      yield* Fiber.join(stop);
      expect(server.requests.at(-1)).toBe("/api/auth/clients/revoke-others");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("fails when a pairing link can't be read, so the stop stays unfinished", () => {
    const server = layerServer();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(stopServerSharing(connection, Effect.fail("no socket")));
      expect(error.message).toContain("couldn't be signed out");
    }).pipe(Effect.provide(server.layer));
  });
});

describe("setServerSharingMode", () => {
  it.effect("asks the server to change the mode", () => {
    const server = layerServer();
    return Effect.gen(function* () {
      yield* setServerSharingMode(connection, "view-only");
      expect(server.requests).toEqual(["/api/connect/sharing-mode"]);
    }).pipe(Effect.provide(server.layer));
  });
});
