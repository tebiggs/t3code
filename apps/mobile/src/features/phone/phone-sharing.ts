import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  deregisterManagedRelayEnvironment,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay";
import { makeEnvironmentHttpApiClient, request, runStream } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentCloudLinkStateResult,
  type EnvironmentConnectReachability,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import type { SavedRemoteConnection } from "../../lib/connection";
import { appAtomRegistry } from "../../state/atom-registry";
import { linkEnvironmentToCloudWithPreference } from "../cloud/linkEnvironment";

export class PhoneSharingError extends Data.TaggedError("PhoneSharingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Whether other devices on the user's T3 Connect account can reach the phone's server. */
export type PhoneSharing =
  | { readonly shared: false }
  | { readonly shared: true; readonly reachability: EnvironmentConnectReachability | null };

export function phoneSharingFromLinkState(state: EnvironmentCloudLinkStateResult): PhoneSharing {
  return state.linked && !state.linkRevoked && state.managedTunnelActive
    ? { shared: true, reachability: state.reachability ?? null }
    : { shared: false };
}

// As `t3 connect` waits: a new tunnel's hostname takes a while to resolve.
const REACHABILITY_CHECK_TIMEOUT = Duration.seconds(30);
const REACHABILITY_RETRY = Duration.seconds(5);
const REACHABILITY_RETRIES = 11;

const failWith = (message: string) => (cause: unknown) => new PhoneSharingError({ message, cause });

const phoneServerApi = Effect.fn("PhoneSharing.phoneServerApi")(function* (
  connection: SavedRemoteConnection,
) {
  if (connection.bearerToken === null) {
    return yield* new PhoneSharingError({ message: "Connect this phone again from phone setup." });
  }
  const api = yield* makeEnvironmentHttpApiClient(connection.httpBaseUrl);
  return { api, headers: { authorization: `Bearer ${connection.bearerToken}` } };
});

const readSharing = Effect.fn("PhoneSharing.read")(function* (connection: SavedRemoteConnection) {
  const { api, headers } = yield* phoneServerApi(connection);
  const state = yield* api.connect
    .linkState({ headers })
    .pipe(Effect.mapError(failWith("Couldn't check whether this phone is shared.")));
  return phoneSharingFromLinkState(state);
});

/** cloudflared runs the tunnel; the phone's Ubuntu starts without it. */
const ensureRelayClient = Effect.fn("PhoneSharing.ensureRelayClient")(function* (
  connection: SavedRemoteConnection,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const status = yield* registry
    .run(connection.environmentId, request(WS_METHODS.cloudGetRelayClientStatus, {}))
    .pipe(Effect.mapError(failWith("Couldn't check for the T3 Connect relay client.")));
  if (status.status === "available") return;
  if (status.status === "unsupported") {
    return yield* new PhoneSharingError({
      message: `T3 Connect has no relay client for ${status.platform}-${status.arch}.`,
    });
  }
  const installed = yield* registry
    .runStream(connection.environmentId, runStream(WS_METHODS.cloudInstallRelayClient, {}))
    .pipe(
      Stream.runLast,
      Effect.mapError(failWith("Couldn't install the T3 Connect relay client.")),
    );
  if (
    Option.isNone(installed) ||
    installed.value.type !== "complete" ||
    installed.value.status.status !== "available"
  ) {
    return yield* new PhoneSharingError({
      message: "The T3 Connect relay client didn't install.",
    });
  }
});

export const readPhoneSharing = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:read-sharing",
  execute: readSharing,
});

/**
 * Links the phone's server to the signed-in T3 Connect account with a managed tunnel. The
 * server keeps listening on loopback; cloudflared reaches it there and connects out.
 */
export const sharePhoneServer = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:share",
  execute: Effect.fn("PhoneSharing.share")(function* (input: {
    readonly connection: SavedRemoteConnection;
    readonly clerkToken: string;
    readonly liveActivitiesEnabled: boolean;
  }) {
    yield* ensureRelayClient(input.connection);
    yield* linkEnvironmentToCloudWithPreference(input).pipe(
      Effect.mapError((cause) => new PhoneSharingError({ message: cause.message, cause })),
    );
    const { api, headers } = yield* phoneServerApi(input.connection);
    // The link stands without a passing check; the last result says why devices can't connect.
    const reachability = yield* api.connect.checkReachability({ headers }).pipe(
      Effect.timeout(REACHABILITY_CHECK_TIMEOUT),
      Effect.orElseSucceed(() => null),
      Effect.repeat({
        schedule: Schedule.spaced(REACHABILITY_RETRY),
        until: (result) => result?.status === "reachable",
        times: REACHABILITY_RETRIES,
      }),
    );
    return { shared: true, reachability } satisfies PhoneSharing;
  }),
});

/** Stops the tunnel on the phone, then removes the phone from the T3 Connect account. */
export const stopSharingPhoneServer = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:stop-sharing",
  execute: Effect.fn("PhoneSharing.stop")(function* (
    input: { readonly connection: SavedRemoteConnection; readonly accountId: string | null },
    registry: AtomRegistry.AtomRegistry,
  ) {
    const { api, headers } = yield* phoneServerApi(input.connection);
    yield* api.connect
      .unlink({ headers })
      .pipe(Effect.mapError(failWith("Couldn't stop sharing this phone.")));
    if (input.accountId === null) return;
    yield* deregisterManagedRelayEnvironment(registry, {
      accountId: input.accountId,
      environmentId: input.connection.environmentId,
    }).pipe(
      Effect.mapError(
        failWith(
          "Stopped sharing, but T3 Connect still lists this phone. Remove it in Settings under T3 Connect.",
        ),
      ),
    );
  }),
});

/**
 * Remove and Reinstall delete the server's link along with Ubuntu, so a shared phone comes off
 * the T3 Connect account first. Best effort: a server that isn't running can't be checked.
 */
export async function releasePhoneSharing(connection: SavedRemoteConnection | null): Promise<void> {
  if (connection === null) return;
  const sharing = await runAtomCommand(appAtomRegistry, readPhoneSharing, connection, {
    reportFailure: false,
  });
  if (!AsyncResult.isSuccess(sharing) || !sharing.value.shared) return;
  await runAtomCommand(
    appAtomRegistry,
    stopSharingPhoneServer,
    { connection, accountId: appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null },
    { reportFailure: false },
  );
}
