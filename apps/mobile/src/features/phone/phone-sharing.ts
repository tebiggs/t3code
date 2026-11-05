import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import type {
  EnvironmentCloudLinkStateResult,
  EnvironmentConnectReachability,
  EnvironmentSharingMode,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import type { SavedRemoteConnection } from "../../lib/connection";

export class PhoneSharingError extends Data.TaggedError("PhoneSharingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const PHONE_STILL_LISTED =
  "T3 Connect still lists this phone. Remove it under Settings > T3 Connect, signed in to the account it was shared with.";

export const VIEW_ONLY_NEEDS_UPDATE =
  "This phone's T3 Code server is too old for View only. Update T3 Code on this phone, then try again.";

/** What the phone's server holds. Any link or tunnel config counts: only Off clears them. */
export type PhoneSharing = (
  | { readonly shared: false }
  | {
      readonly shared: true;
      /** T3 Connect refused the link. The server keeps its tunnel config until it's turned off. */
      readonly revoked: boolean;
      readonly cloudUserId: string | null;
      readonly reachability: EnvironmentConnectReachability | null;
      readonly mode: EnvironmentSharingMode;
      /** The last mode change didn't finish, so earlier sign-ins may keep their old access. */
      readonly modeChangePending: boolean;
    }
) & {
  /** The phone installs its server from releases, so it can be older than this app. */
  readonly modesUnsupported?: true;
};

export function phoneSharingFromLinkState(state: EnvironmentCloudLinkStateResult): PhoneSharing {
  const age =
    state.sharingModeChangePending === undefined ? { modesUnsupported: true as const } : {};
  if (!state.linked && !state.managedTunnelActive) return { shared: false, ...age };
  return {
    ...age,
    shared: true,
    revoked: state.linkRevoked === true,
    cloudUserId: state.cloudUserId,
    reachability: state.reachability ?? null,
    // A server shared before modes existed never stored one, and it still grants everything.
    mode: state.sharingMode ?? "full-control",
    modeChangePending: state.sharingModeChangePending === true,
  };
}

// `t3 connect` waits this long too: a new tunnel's hostname takes a while to resolve.
const REACHABILITY_WAIT = Duration.seconds(60);
const REACHABILITY_CHECK_TIMEOUT = Duration.seconds(30);
const REACHABILITY_RETRY = Duration.seconds(5);
const STOP_STEP_TIMEOUT = Duration.seconds(20);
// The relay client lets open requests run for up to 30 seconds before it exits.
const UNLINK_TIMEOUT = Duration.seconds(45);
const READ_TIMEOUT = Duration.seconds(10);

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
    .pipe(
      Effect.timeout(READ_TIMEOUT),
      Effect.mapError(failWith("Couldn't check whether this phone is shared.")),
    );
  return phoneSharingFromLinkState(state);
});

export const MODE_CHANGE_UNFINISHED =
  "Couldn't finish changing what other devices can do. Devices signed in earlier may keep their old access. Try again.";

/** Stored before other devices are signed out, so one reconnecting now gets the new mode. */
export const setServerSharingMode = Effect.fn("PhoneSharing.setServerSharingMode")(function* (
  connection: SavedRemoteConnection,
  mode: EnvironmentSharingMode,
) {
  const { api, headers } = yield* phoneServerApi(connection);
  yield* api.connect
    .sharingMode({ headers, payload: { mode } })
    .pipe(Effect.timeout(STOP_STEP_TIMEOUT), Effect.mapError(failWith(MODE_CHANGE_UNFINISHED)));
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

/**
 * Off ends access, not just the route to it: without the revocations, a client that connected
 * while the phone was shared would get back in if sharing came on again, even under another
 * account.
 */
export const stopServerSharing = Effect.fn("PhoneSharing.stopServerSharing")(function* <E, R>(
  connection: SavedRemoteConnection,
  pairingLinkIds: Effect.Effect<ReadonlyArray<string>, E, R>,
) {
  const { api, headers } = yield* phoneServerApi(connection);
  // Signing others out first ends their live connections, which the tunnel would wait on.
  // Nothing here may block the stop, so defects are dropped too.
  yield* api.auth
    .revokeOtherClients({ headers })
    .pipe(Effect.timeout(STOP_STEP_TIMEOUT), Effect.ignoreCause);
  yield* api.connect
    .unlink({ headers })
    .pipe(
      Effect.timeout(UNLINK_TIMEOUT),
      Effect.mapError(failWith("Couldn't stop sharing this phone.")),
    );
  yield* Effect.gen(function* () {
    yield* api.auth.revokeOtherClients({ headers });
    const ids = yield* pairingLinkIds;
    yield* Effect.forEach(ids, (id) => api.auth.revokePairingLink({ headers, payload: { id } }), {
      discard: true,
    });
  }).pipe(
    Effect.timeout(STOP_STEP_TIMEOUT),
    Effect.mapError(failWith("The tunnel is off, but other devices couldn't be signed out.")),
  );
});
