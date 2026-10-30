import { describe, expect, it } from "@effect/vitest";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { phoneSharingFromLinkState, stopServerSharing } from "./phone-sharing";

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
  linked: false,
  linkRevoked: false,
  cloudUserId: null,
  relayUrl: null,
  relayIssuer: null,
  managedTunnelActive: false,
  publishAgentActivity: false,
  holdWebhooksWhileOffline: false,
};

function layerServer(failing: ReadonlySet<string> = new Set()) {
  const requests: Array<string> = [];
  const respond = (path: string) => {
    if (failing.has(path)) return Response.json({ error: "no" }, { status: 500 });
    if (path === "/api/connect/unlink") {
      return Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } });
    }
    if (path === "/api/auth/clients/revoke-others") return Response.json({ revokedCount: 2 });
    return Response.json({ revoked: true });
  };
  const layer = layerRemoteHttpClient((input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    return Promise.resolve(respond(path));
  });
  return { requests, layer };
}

describe("phoneSharingFromLinkState", () => {
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
    ).toEqual({ shared: true, revoked: true, cloudUserId: "user_a", reachability: null });
    expect(phoneSharingFromLinkState({ ...linkState, managedTunnelActive: true }).shared).toBe(
      true,
    );
  });
});

describe("stopServerSharing", () => {
  it.effect("stops the tunnel, then signs out other clients and their pairing links", () => {
    const server = layerServer();
    return Effect.gen(function* () {
      yield* stopServerSharing(connection, Effect.succeed(["link-1"]));
      expect(server.requests).toEqual([
        "/api/connect/unlink",
        "/api/auth/clients/revoke-others",
        "/api/auth/pairing-links/revoke",
      ]);
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
