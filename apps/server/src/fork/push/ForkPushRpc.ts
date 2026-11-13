import { FORK_PUSH_WS_METHODS, ForkPushError, type ForkPushStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { PUBLISH_AGENT_ACTIVITY_SECRET } from "../../cloud/config.ts";
import * as ForkPushSender from "./ForkPushSender.ts";
import * as PushHost from "./PushHost.ts";

const NOT_A_HOST = "This environment holds no FCM key, so it is not a push host.";

/** WebSocket handlers for the fork's push host, spread into ws.ts's handler set. */
export const makeHandlers = Effect.gen(function* () {
  const host = yield* PushHost.PushHost;
  const sender = yield* ForkPushSender.ForkPushSender;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const status = Effect.gen(function* () {
    const toggle = yield* secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const hostStatus = host.enabled ? yield* host.status : { devices: [], peers: [] };
    return {
      ...(yield* sender.status),
      publishingOff: Option.getOrNull(toggle) === "false",
      ...hostStatus,
    } satisfies ForkPushStatus;
  }).pipe(Effect.withSpan("ForkPushRpc.status"));

  return {
    [FORK_PUSH_WS_METHODS.getStatus]: () => status,
    [FORK_PUSH_WS_METHODS.registerDevice]: (
      input: Parameters<PushHost.PushHost["Service"]["registerDevice"]>[0],
    ) =>
      host.enabled
        ? host.registerDevice(input).pipe(Effect.as({}))
        : Effect.fail(new ForkPushError({ message: NOT_A_HOST })),
    [FORK_PUSH_WS_METHODS.unregisterDevice]: (input: { readonly deviceId: string }) =>
      host.unregisterDevice(input.deviceId).pipe(Effect.map((removed) => ({ removed }))),
    [FORK_PUSH_WS_METHODS.sendTest]: (input: { readonly deviceId: string }) =>
      host.enabled
        ? host.sendTest(input.deviceId).pipe(
            Effect.mapError((message) => new ForkPushError({ message })),
            Effect.flatMap((sent) =>
              sent
                ? Effect.succeed({})
                : Effect.fail(
                    new ForkPushError({ message: "This device is not registered here." }),
                  ),
            ),
          )
        : Effect.fail(new ForkPushError({ message: NOT_A_HOST })),
  };
});

const unavailable = Effect.fail(new ForkPushError({ message: NOT_A_HOST }));

/**
 * The handlers, captured where ws.ts builds its route and provided to each connection. Without
 * them, as in ws.ts's own tests, this server reports no push host.
 */
export const ForkPushHandlers = Context.Reference<Effect.Success<typeof makeHandlers>>(
  "t3/fork/push/ForkPushRpc/ForkPushHandlers",
  {
    defaultValue: () => ({
      [FORK_PUSH_WS_METHODS.getStatus]: () =>
        Effect.succeed({
          role: "none",
          host: null,
          checkedAt: null,
          error: null,
          publishingOff: false,
          devices: [],
          peers: [],
        } satisfies ForkPushStatus),
      [FORK_PUSH_WS_METHODS.registerDevice]: () => unavailable,
      [FORK_PUSH_WS_METHODS.unregisterDevice]: () => Effect.succeed({ removed: false }),
      [FORK_PUSH_WS_METHODS.sendTest]: () => unavailable,
    }),
  },
);
