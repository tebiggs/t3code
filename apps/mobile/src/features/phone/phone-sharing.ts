import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import type {
  EnvironmentCloudLinkStateResult,
  EnvironmentConnectReachability,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import type { SavedRemoteConnection } from "../../lib/connection";

export class PhoneSharingError extends Data.TaggedError("PhoneSharingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const PHONE_STILL_LISTED =
  "T3 Connect still lists this phone. Remove it under Settings > T3 Connect, signed in to the account it was shared with.";

/** What the phone's server holds. Any link or tunnel config counts: only Off clears them. */
export type PhoneSharing =
  | { readonly shared: false }
  | {
      readonly shared: true;
      /** T3 Connect refused the link. The server keeps its tunnel config until it's turned off. */
      readonly revoked: boolean;
      readonly cloudUserId: string | null;
      readonly reachability: EnvironmentConnectReachability | null;
    };

export function phoneSharingFromLinkState(state: EnvironmentCloudLinkStateResult): PhoneSharing {
  if (!state.linked && !state.managedTunnelActive) return { shared: false };
  return {
    shared: true,
    revoked: state.linkRevoked === true,
    cloudUserId: state.cloudUserId,
    reachability: state.reachability ?? null,
  };
}

// `t3 connect` waits this long too: a new tunnel's hostname takes a while to resolve.
const REACHABILITY_WAIT = Duration.seconds(60);
const REACHABILITY_CHECK_TIMEOUT = Duration.seconds(30);
const REACHABILITY_RETRY = Duration.seconds(5);

export const failWith = (message: string) => (cause: unknown) =>
  new PhoneSharingError({ message, cause });

const phoneServerApi = Effect.fn("PhoneSharing.phoneServerApi")(function* (
  connection: SavedRemoteConnection,
) {
  if (connection.bearerToken === null) {
    return yield* new PhoneSharingError({ message: "Connect this phone again from phone setup." });
  }
  const api = yield* makeEnvironmentHttpApiClient(connection.httpBaseUrl);
  return { api, headers: { authorization: `Bearer ${connection.bearerToken}` } };
});

export const readSharing = Effect.fn("PhoneSharing.read")(function* (
  connection: SavedRemoteConnection,
) {
  const { api, headers } = yield* phoneServerApi(connection);
  const state = yield* api.connect
    .linkState({ headers })
    .pipe(Effect.mapError(failWith("Couldn't check whether this phone is shared.")));
  return phoneSharingFromLinkState(state);
});

/** The latest result when the time is up; the link stands whatever this finds. */
export const waitForReachability = Effect.fn("PhoneSharing.waitForReachability")(function* (
  connection: SavedRemoteConnection,
) {
  const { api, headers } = yield* phoneServerApi(connection);
  const latest = yield* Ref.make<EnvironmentConnectReachability | null>(null);
  yield* api.connect.checkReachability({ headers }).pipe(
    Effect.tap((result) => Ref.set(latest, result)),
    Effect.timeout(REACHABILITY_CHECK_TIMEOUT),
    Effect.orElseSucceed(() => null),
    Effect.repeat({
      schedule: Schedule.spaced(REACHABILITY_RETRY),
      until: (result) => result?.status === "reachable",
    }),
    Effect.timeoutOption(REACHABILITY_WAIT),
  );
  return yield* Ref.get(latest);
});

/** Stops the tunnel. Credentials that clients already hold outlive it. */
export const unlinkServer = Effect.fn("PhoneSharing.unlinkServer")(function* (
  connection: SavedRemoteConnection,
) {
  const { api, headers } = yield* phoneServerApi(connection);
  yield* api.connect
    .unlink({ headers })
    .pipe(Effect.mapError(failWith("Couldn't stop sharing this phone.")));
});

/**
 * Off ends access, not just the route to it: without this, a client that connected while the
 * phone was shared would get back in if sharing came on again, even under another account.
 */
const revokeOtherAccess = Effect.fn("PhoneSharing.revokeOtherAccess")(function* <E, R>(
  connection: SavedRemoteConnection,
  pairingLinkIds: Effect.Effect<ReadonlyArray<string>, E, R>,
) {
  const { api, headers } = yield* phoneServerApi(connection);
  yield* api.auth.revokeOtherClients({ headers });
  const ids = yield* pairingLinkIds;
  yield* Effect.forEach(ids, (id) => api.auth.revokePairingLink({ headers, payload: { id } }), {
    discard: true,
  });
});

/** Each step runs even when the one before it failed, so one failure can't leave access open. */
export const stopServerSharing = Effect.fn("PhoneSharing.stopServerSharing")(function* <
  E1,
  R1,
  E2,
  R2,
>(
  connection: SavedRemoteConnection,
  steps: {
    readonly pairingLinkIds: Effect.Effect<ReadonlyArray<string>, E1, R1>;
    readonly deregister: Effect.Effect<void, E2, R2>;
  },
) {
  yield* unlinkServer(connection);
  // Exits, not typed failures: a defect in one step must not skip the next either.
  const revoked = yield* Effect.exit(revokeOtherAccess(connection, steps.pairingLinkIds));
  const deregistered = yield* Effect.exit(steps.deregister);
  if (Exit.isFailure(revoked)) {
    yield* Effect.logWarning("Couldn't sign out the phone's other clients", revoked.cause);
    return yield* new PhoneSharingError({
      message: "The tunnel is off, but other devices couldn't be signed out. Try again.",
    });
  }
  if (Exit.isFailure(deregistered)) {
    yield* Effect.logWarning("Couldn't deregister the phone", deregistered.cause);
    return yield* new PhoneSharingError({ message: PHONE_STILL_LISTED });
  }
});
