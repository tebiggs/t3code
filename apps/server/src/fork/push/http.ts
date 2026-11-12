import {
  RelayAgentActivityPublishRequest,
  type RelayPublishResponse,
} from "@t3tools/contracts/relay";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { PUSH_ROUTE_PREFIX } from "./ForkPushSender.ts";
import * as PushHost from "./PushHost.ts";

const NO_STORE = { "cache-control": "no-store" };
const MAX_BODY_BYTES = 64 * 1024;

const PublishParams = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
});
const decodeBody = Schema.decodeUnknownEffect(RelayAgentActivityPublishRequest);

const refuse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status, headers: NO_STORE });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const host = yield* PushHost.PushHost;
    const environment = yield* ServerEnvironment.ServerEnvironment;

    /** A linked environment's session, the credential every push route takes. */
    const peerSession = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
      return session._tag === "Some" && session.value.peerLink ? session.value : null;
    });

    const infoRoute = HttpRouter.add(
      "GET",
      `${PUSH_ROUTE_PREFIX}/info`,
      Effect.gen(function* () {
        if ((yield* peerSession) === null) {
          return refuse(401, "A linked environment's session is required.");
        }
        return HttpServerResponse.jsonUnsafe(
          { pushHost: host.enabled, environmentId: yield* environment.getEnvironmentId },
          { headers: NO_STORE },
        );
      }),
    );

    /** Upstream's relay publish endpoint, so a peer's AgentAwarenessRelay posts here unchanged. */
    const publishRoute = HttpRouter.add(
      "POST",
      `${PUSH_ROUTE_PREFIX}/environments/:environmentId/threads/:threadId/agent-activity`,
      Effect.gen(function* () {
        // A link's session names only its label, not the environment behind it, so an update is
        // not tied to the link that sent it; a link already reads this server's threads anyway.
        if ((yield* peerSession) === null) {
          return refuse(401, "A linked environment's session is required.");
        }
        if (!host.enabled) return refuse(404, "This environment is not a push host.");
        const params = yield* HttpRouter.schemaPathParams(PublishParams).pipe(Effect.option);
        if (params._tag === "None") return refuse(400, "Bad environment or thread.");
        const { environmentId, threadId } = params.value;
        if (environmentId === (yield* environment.getEnvironmentId)) {
          return refuse(403, "The push host publishes its own threads itself.");
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
          Effect.flatMap(decodeBody),
          Effect.option,
        );
        if (body._tag === "None") return refuse(400, "Bad agent activity.");
        const state = body.value.state;
        if (
          state !== null &&
          (state.environmentId !== environmentId || state.threadId !== threadId)
        ) {
          return refuse(400, "The state belongs to another thread.");
        }
        const deviceIds = yield* host.ingest({ environmentId, threadId, state });
        const response: RelayPublishResponse = {
          ok: true,
          deliveries: deviceIds.map((deviceId) => ({
            deviceId,
            kind: "push_notification",
            ok: true,
            queued: true,
            apnsStatus: null,
            apnsReason: null,
            apnsId: null,
          })),
        };
        return HttpServerResponse.jsonUnsafe(response, { headers: NO_STORE });
      }),
    );

    return Layer.mergeAll(infoRoute, publishRoute);
  }),
);
