import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { isAgentActivityPublishingEnabledValue } from "../../cloud/config.ts";

/** Where AgentAwarenessRelay sends agent activity instead of the T3 Connect relay. */
export interface ForkPushRoute {
  /** The relay API base URL, or a `fork-push:` name when `deliver` takes the update in process. */
  readonly url: string;
  readonly issuer: string;
  readonly environmentCredential: string;
  readonly deliver?: (input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly state: RelayAgentActivityState | null;
  }) => Effect.Effect<void>;
}

/** Nothing here by default, so a server without the fork's push host publishes as upstream does. */
export const ForkPushTarget = Context.Reference<{
  readonly resolve: Effect.Effect<ForkPushRoute | null>;
}>("t3/fork/push/ForkPushTarget", { defaultValue: () => ({ resolve: Effect.succeed(null) }) });

/**
 * Upstream's toggle publishes only when it is set to on, and T3 Connect sets it. Updates to the
 * push host stay on the owner's own servers, so there they flow unless the toggle is explicitly off.
 */
export const publishEnabled = (toggle: string | null, route: ForkPushRoute | null) =>
  route === null ? isAgentActivityPublishingEnabledValue(toggle) : toggle !== "false";
