import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, type PeerLinkSummary, PeerLinkError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "../../peer/PeerLinks.ts";
import { PushHostFcm } from "./fcm.ts";
import * as ForkPushSender from "./ForkPushSender.ts";
import * as PushHost from "./PushHost.ts";
import * as PushHostStore from "./PushHostStore.ts";

const HOST_ID = EnvironmentId.make("env-host");
const HOST_URL = "https://host.example.test";

const link = (status: PeerLinkSummary["status"]): PeerLinkSummary => ({
  environmentId: HOST_ID,
  label: "Host",
  urls: [HOST_URL],
  access: "read-only",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status,
});

const peerHarness = () => {
  const current = { status: "reachable" as PeerLinkSummary["status"], infoAsks: [] as string[] };
  const peerLinks = Layer.mock(PeerLinks.PeerLinks)({
    list: Effect.sync(() => [link(current.status)]),
    resolve: () =>
      current.status === "expired"
        ? Effect.fail(
            new PeerLinkError({ reason: "expired", message: "The link to Host expired." }),
          )
        : Effect.succeed({ link: link(current.status), url: HOST_URL, token: "link-token" }),
  });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        current.infoAsks.push(`${request.url} ${request.headers.authorization}`);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ pushHost: true, environmentId: HOST_ID }),
        );
      }),
    ),
  );
  const host = PushHost.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PushHostFcm, PushHostFcm.of({ send: null, projectId: null })),
        PushHostStore.layerMemory(),
        NodeCrypto.layer,
      ),
    ),
  );
  return {
    current,
    layer: ForkPushSender.layer.pipe(Layer.provide(Layer.mergeAll(peerLinks, http, host))),
  };
};

describe("ForkPushSender", () => {
  it.effect("delivers in process on the push host", () =>
    Effect.gen(function* () {
      const sender = yield* ForkPushSender.ForkPushSender;
      const host = yield* PushHost.PushHost;
      const route = yield* sender.resolve;
      assert.strictEqual(route?.url, "fork-push:local");
      yield* route!.deliver!({ environmentId: "env-host", threadId: "thread", state: null });
      assert.deepStrictEqual(
        (yield* host.status).peers.map((peer) => peer.environmentId),
        ["env-host"],
      );
      assert.strictEqual((yield* sender.status).role, "host");
    }).pipe(
      Effect.provide(
        ForkPushSender.layer.pipe(
          // The push host never looks at its own links.
          Layer.provide(
            Layer.merge(
              Layer.mock(PeerLinks.PeerLinks)({}),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("unused")),
              ),
            ),
          ),
          Layer.provideMerge(
            PushHost.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    PushHostFcm,
                    PushHostFcm.of({
                      send: () => Effect.succeed({ unregistered: false }),
                      projectId: "project",
                    }),
                  ),
                  PushHostStore.layerMemory(),
                  NodeCrypto.layer,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("sends to the linked push host, and stops when the link lapses", () => {
    const { current, layer } = peerHarness();
    return Effect.gen(function* () {
      const sender = yield* ForkPushSender.ForkPushSender;
      yield* sender.refresh;
      assert.strictEqual(
        current.infoAsks[0],
        `${HOST_URL}/api/fork/push/v1/info Bearer link-token`,
      );
      const route = yield* sender.resolve;
      assert.deepStrictEqual(route, {
        url: `${HOST_URL}/api/fork/push`,
        issuer: HOST_URL,
        environmentCredential: "link-token",
      });
      const status = yield* sender.status;
      assert.strictEqual(status.role, "sender");
      assert.strictEqual(status.host?.linkExpiresAt, "2026-12-01T00:00:00.000Z");

      const changes = yield* sender.subscribe;
      current.status = "expired";
      yield* sender.refresh;
      yield* PubSub.take(changes);
      assert.isNull(yield* sender.resolve);
      const lapsed = yield* sender.status;
      assert.strictEqual(lapsed.role, "none");
      assert.strictEqual(lapsed.host?.environmentId, HOST_ID);
      assert.strictEqual(lapsed.error, "The link to Host expired.");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
