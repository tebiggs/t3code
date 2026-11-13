import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../../serverActivation.ts";
import * as Fcm from "./fcm.ts";
import * as ForkPushSender from "./ForkPushSender.ts";
import * as PushHttp from "./http.ts";
import * as PushHost from "./PushHost.ts";
import * as PushHostStore from "./PushHostStore.ts";

/** One instance, shared by the routes, the WebSocket handlers and the sender through layer memoization. */
export const layerPushHost = PushHost.layer.pipe(
  Layer.provide(Layer.merge(Fcm.layer, PushHostStore.layer)),
);

export const layerSender = ForkPushSender.layer.pipe(
  Layer.provide(Layer.merge(layerPushHost, PeerLinks.layer)),
);

/** AgentAwarenessRelay, publishing to the push host when there is one. */
export const layerAgentAwarenessRelay = Layer.effectDiscard(
  Effect.gen(function* () {
    const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
    const sender = yield* ForkPushSender.ForkPushSender;
    const changes = yield* sender.subscribe;
    // A new route has none of this server's active threads yet.
    yield* forkParked(
      PubSub.take(changes).pipe(Effect.andThen(relay.requestCatchUp()), Effect.forever),
    );
  }),
).pipe(
  Layer.provideMerge(AgentAwarenessRelay.layer),
  Layer.provide(ForkPushSender.layerTarget),
  Layer.provideMerge(layerSender),
);

export const layerRoutes = PushHttp.layer.pipe(Layer.provide(layerPushHost));
