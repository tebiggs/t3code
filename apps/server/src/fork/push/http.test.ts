import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { PushHostFcm } from "./fcm.ts";
import * as PushHttp from "./http.ts";
import * as PushHost from "./PushHost.ts";
import * as PushHostStore from "./PushHostStore.ts";

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env-peer"),
  threadId: ThreadId.make("thread-1"),
  projectTitle: "Project",
  threadTitle: "Thread",
  phase: "running",
  headline: "Working",
  modelTitle: "Claude",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env-peer/thread-1",
};

const session = (peerLink: boolean): EnvironmentAuth.McpClientSession => ({
  sessionId: AuthSessionId.make("session"),
  label: "T3 Code · Peer",
  access: "read-only",
  peerLink,
});

const serve = (options: { readonly enabled: boolean }) =>
  Effect.gen(function* () {
    const sessions = new Map([
      ["Bearer peer", session(true)],
      ["Bearer agent", session(false)],
    ]);
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      authenticateMcpClient: (request) => {
        const found = sessions.get(request.headers.authorization ?? "");
        return found === undefined
          ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
          : Effect.succeed(found);
      },
    });
    const environment = Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-host")),
    });
    const fcm = Layer.succeed(
      PushHostFcm,
      PushHostFcm.of({
        send: options.enabled ? () => Effect.succeed({ unregistered: false }) : null,
        projectId: null,
      }),
    );
    const host = yield* Layer.build(
      PushHost.layer.pipe(
        Layer.provide(Layer.mergeAll(fcm, PushHostStore.layerMemory(), NodeCrypto.layer)),
      ),
    );
    const routes = PushHttp.layer.pipe(
      Layer.provide(Layer.mergeAll(auth, environment, Layer.succeedContext(host))),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const publish = (input: {
      readonly token: string;
      readonly environmentId?: string;
      readonly body?: unknown;
    }) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(
            `http://localhost/api/fork/push/v1/environments/${input.environmentId ?? "env-peer"}/threads/thread-1/agent-activity`,
            {
              method: "POST",
              headers: { authorization: input.token, "content-type": "application/json" },
              body: JSON.stringify(input.body ?? { state, proof: "proof" }),
            },
          ),
        );
        return response.status;
      });
    const info = (token: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request("http://localhost/api/fork/push/v1/info", {
            headers: { authorization: token },
          }),
        );
        return { status: response.status, body: response.ok ? await response.json() : null };
      });
    return { host: Context.get(host, PushHost.PushHost), publish, info };
  });

describe("push host routes", () => {
  it.effect("take updates only from a linked environment's session, for its own threads", () =>
    Effect.gen(function* () {
      const { host, publish, info } = yield* serve({ enabled: true });
      assert.strictEqual(yield* publish({ token: "Bearer agent" }), 401);
      assert.strictEqual(yield* publish({ token: "Bearer nobody" }), 401);
      assert.strictEqual(yield* publish({ token: "Bearer peer", environmentId: "env-host" }), 403);
      assert.strictEqual(
        yield* publish({
          token: "Bearer peer",
          body: { state: { ...state, threadId: "thread-2" }, proof: "proof" },
        }),
        400,
      );
      assert.deepStrictEqual((yield* host.status).peers, []);
      assert.strictEqual(yield* publish({ token: "Bearer peer" }), 200);
      assert.deepStrictEqual(
        (yield* host.status).peers.map((peer) => peer.environmentId),
        ["env-peer"],
      );
      assert.deepStrictEqual(yield* info("Bearer peer"), {
        status: 200,
        body: { pushHost: true, environmentId: "env-host" },
      });
      assert.strictEqual((yield* info("Bearer agent")).status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("refuse updates when this server holds no key", () =>
    Effect.gen(function* () {
      const { publish, info } = yield* serve({ enabled: false });
      assert.strictEqual(yield* publish({ token: "Bearer peer" }), 404);
      assert.deepStrictEqual((yield* info("Bearer peer")).body, {
        pushHost: false,
        environmentId: "env-host",
      });
    }).pipe(Effect.scoped),
  );
});
