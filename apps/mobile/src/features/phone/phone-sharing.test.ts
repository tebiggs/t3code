import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { phoneSharingFromLinkState, PHONE_STILL_LISTED, stopServerSharing } from "./phone-sharing";

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
  const deregister = vi.fn(() => Effect.void);
  beforeEach(() => {
    deregister.mockClear();
  });

  it.effect("stops the tunnel, then signs out other clients and their pairing links", () => {
    const server = layerServer();
    return Effect.gen(function* () {
      yield* stopServerSharing(connection, {
        pairingLinkIds: Effect.succeed(["link-1"]),
        deregister: Effect.suspend(deregister),
      });
      expect(server.requests).toEqual([
        "/api/connect/unlink",
        "/api/auth/clients/revoke-others",
        "/api/auth/pairing-links/revoke",
      ]);
      expect(deregister).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("leaves the account alone when the tunnel didn't stop", () => {
    const server = layerServer(new Set(["/api/connect/unlink"]));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stopServerSharing(connection, {
          pairingLinkIds: Effect.succeed([]),
          deregister: Effect.suspend(deregister),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(deregister).not.toHaveBeenCalled();
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("still deregisters when signing out clients fails, and reports the failure", () => {
    const server = layerServer(new Set(["/api/auth/clients/revoke-others"]));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        stopServerSharing(connection, {
          pairingLinkIds: Effect.succeed([]),
          deregister: Effect.suspend(deregister),
        }),
      );
      expect(error.message).toContain("couldn't be signed out");
      expect(deregister).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("says so when the account still lists the phone", () => {
    const server = layerServer();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        stopServerSharing(connection, {
          pairingLinkIds: Effect.succeed([]),
          deregister: Effect.fail("relay down"),
        }),
      );
      expect(error.message).toBe(PHONE_STILL_LISTED);
    }).pipe(Effect.provide(server.layer));
  });
});
