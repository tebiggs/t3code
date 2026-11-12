import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as PeerLinks from "../../peer/PeerLinks.ts";
import { type ForkPushRoute, ForkPushTarget } from "./ForkPushTarget.ts";
import * as PushHost from "./PushHost.ts";

export const PUSH_ROUTE_PREFIX = "/api/fork/push/v1";
const LOCAL_ROUTE_URL = "fork-push:local";
/** Links are re-checked this often, so a host found, lost or moved shows up within minutes. */
const REFRESH_INTERVAL = "2 minutes";

export const PushHostInfo = Schema.Struct({
  pushHost: Schema.Boolean,
  environmentId: Schema.String,
});

export interface ForkPushSenderStatus {
  readonly role: "host" | "sender" | "none";
  /** The linked environment this server sends to, once one answered as the push host. */
  readonly host: {
    readonly environmentId: string;
    readonly label: string;
    readonly url: string;
    readonly linkExpiresAt: string;
  } | null;
  readonly checkedAt: string | null;
  readonly error: string | null;
}

interface SenderState {
  readonly route: ForkPushRoute | null;
  readonly status: ForkPushSenderStatus;
}

/**
 * Finds where this server's agent activity goes: into its own PushHost when it holds the FCM key,
 * otherwise to the first linked environment that answers as a push host.
 */
export class ForkPushSender extends Context.Service<
  ForkPushSender,
  {
    readonly resolve: Effect.Effect<ForkPushRoute | null>;
    readonly status: Effect.Effect<ForkPushSenderStatus>;
    /** Checks the links again now, as a relink does. */
    readonly refresh: Effect.Effect<void>;
    /** Takes one value each time the route changes, so active threads can be published again. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/fork/push/ForkPushSender") {}

const routeKey = (route: ForkPushRoute | null) =>
  route === null ? "" : `${route.url}\n${route.environmentCredential}`;

const make = Effect.gen(function* () {
  const pushHost = yield* PushHost.PushHost;
  const changes = yield* PubSub.unbounded<void>();

  if (pushHost.enabled) {
    const route: ForkPushRoute = {
      url: LOCAL_ROUTE_URL,
      issuer: LOCAL_ROUTE_URL,
      environmentCredential: LOCAL_ROUTE_URL,
      deliver: (input) => pushHost.ingest(input).pipe(Effect.asVoid),
    };
    return ForkPushSender.of({
      resolve: Effect.succeed(route),
      status: Effect.succeed({ role: "host", host: null, checkedAt: null, error: null }),
      refresh: Effect.void,
      subscribe: PubSub.subscribe(changes),
    });
  }

  const peerLinks = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  const stateRef = yield* Ref.make<SenderState>({
    route: null,
    status: { role: "none", host: null, checkedAt: null, error: null },
  });

  const askInfo = (url: string, token: string) =>
    HttpClientRequest.get(`${url}${PUSH_ROUTE_PREFIX}/info`).pipe(
      HttpClientRequest.bearerToken(token),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PushHostInfo)),
      Effect.timeout("10 seconds"),
      Effect.option,
    );

  /** The push host behind one link, or why that link cannot reach it. */
  const probe = Effect.fn("ForkPushSender.probe")(function* (environmentId: EnvironmentId) {
    const resolved = yield* peerLinks.resolve(environmentId).pipe(Effect.result);
    if (resolved._tag === "Failure") return { found: null, error: resolved.failure.message };
    const { link, url, token } = resolved.success;
    const info = yield* askInfo(url, token);
    if (Option.isNone(info) || !info.value.pushHost) return { found: null, error: null };
    return {
      found: {
        route: {
          url: `${url}/api/fork/push`,
          issuer: url,
          environmentCredential: token,
        } satisfies ForkPushRoute,
        host: {
          environmentId: link.environmentId,
          label: link.label,
          url,
          linkExpiresAt: DateTime.formatIso(link.expiresAt),
        },
      },
      error: null,
    };
  });

  const refresh = Effect.gen(function* () {
    const previous = yield* Ref.get(stateRef);
    const links = yield* peerLinks.list.pipe(Effect.orElseSucceed(() => []));
    const known = previous.status.host?.environmentId;
    // The host found last time is asked first; others only while it is not answering.
    const candidates = [
      ...links.filter((link) => link.environmentId === known),
      ...links.filter((link) => link.environmentId !== known && link.status === "reachable"),
    ];
    let found: Effect.Success<ReturnType<typeof probe>>["found"] = null;
    let error: string | null = null;
    for (const link of candidates) {
      const result = yield* probe(link.environmentId);
      if (link.environmentId === known) error = result.error;
      if (result.found !== null) {
        found = result.found;
        error = null;
        break;
      }
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const knownLink = links.find((link) => link.environmentId === known);
    const next: SenderState =
      found !== null
        ? {
            route: found.route,
            status: { role: "sender", host: found.host, checkedAt: now, error: null },
          }
        : {
            route: null,
            status: {
              role: "none",
              // A host that stops answering stays named, with the reason, until it is unlinked.
              host:
                previous.status.host !== null && knownLink !== undefined
                  ? {
                      ...previous.status.host,
                      linkExpiresAt: DateTime.formatIso(knownLink.expiresAt),
                    }
                  : null,
              checkedAt: now,
              error,
            },
          };
    yield* Ref.set(stateRef, next);
    if (routeKey(previous.route) !== routeKey(next.route)) {
      yield* Effect.logInfo("Push host route changed", {
        host: next.status.host?.environmentId ?? null,
        url: next.route?.url ?? null,
      });
      yield* PubSub.publish(changes, undefined);
    }
  }).pipe(Effect.withSpan("ForkPushSender.refresh"));

  yield* refresh.pipe(
    Effect.repeat(Schedule.spaced(REFRESH_INTERVAL)),
    Effect.catchCause((cause) => Effect.logWarning("Push host lookup stopped", { cause })),
    Effect.forkScoped,
  );

  return ForkPushSender.of({
    resolve: Ref.get(stateRef).pipe(Effect.map((state) => state.route)),
    status: Ref.get(stateRef).pipe(Effect.map((state) => state.status)),
    refresh,
    subscribe: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(ForkPushSender, make);

/** Hands AgentAwarenessRelay the sender's route. */
export const layerTarget = Layer.effect(
  ForkPushTarget,
  ForkPushSender.pipe(Effect.map((sender) => ({ resolve: sender.resolve }))),
);
