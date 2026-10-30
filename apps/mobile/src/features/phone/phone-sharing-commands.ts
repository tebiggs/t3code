import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  deregisterManagedRelayEnvironment,
  type ManagedRelay,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay";
import { request, runStream, subscribe } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import type { SavedRemoteConnection } from "../../lib/connection";
import type { PhoneServerSettings } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { phoneServerSettingsAtom, setPhoneServerSettings } from "../../state/phone-server-settings";
import { savedRemoteConnectionAtom } from "../../state/use-remote-environment-registry";
import { linkEnvironmentToCloudWithPreference } from "../cloud/linkEnvironment";
import {
  failWith,
  PHONE_STILL_LISTED,
  PhoneSharingError,
  readSharing,
  stopServerSharing,
  unlinkServer,
  waitForReachability,
} from "./phone-sharing";

const PAIRING_LINKS_TIMEOUT = Duration.seconds(10);

/** Remembers the account a shared phone is listed under, for the times its server is down. */
function setSharingRecord(sharing: PhoneServerSettings["sharing"]) {
  const settings = appAtomRegistry.get(phoneServerSettingsAtom);
  if (settings !== null) setPhoneServerSettings({ ...settings, sharing });
}

const deregister = (
  registry: AtomRegistry.AtomRegistry,
  accountId: string,
  environmentId: EnvironmentId,
) =>
  deregisterManagedRelayEnvironment(registry, { accountId, environmentId }).pipe(
    Effect.tap(() => Effect.sync(() => setSharingRecord(undefined))),
  );

const pairingLinkIds = Effect.fn("PhoneSharing.pairingLinkIds")(function* (
  environmentId: EnvironmentId,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const first = yield* registry
    .runStream(environmentId, subscribe(WS_METHODS.subscribeAuthAccess, {}))
    .pipe(
      Stream.filter((event) => event.type === "snapshot"),
      Stream.runHead,
      Effect.timeout(PAIRING_LINKS_TIMEOUT),
    );
  return Option.match(first, {
    onNone: () => [],
    onSome: (event) =>
      event.type === "snapshot" ? event.payload.pairingLinks.map((link) => link.id) : [],
  });
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

export const checkPhoneReachability = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:check-reachability",
  execute: waitForReachability,
});

/**
 * Links the phone's server to the signed-in T3 Connect account with a managed tunnel. The
 * server keeps listening on loopback; cloudflared reaches it there and connects out.
 */
export const sharePhoneServer = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:share",
  execute: Effect.fn("PhoneSharing.share")(function* (
    input: {
      readonly connection: SavedRemoteConnection;
      readonly accountId: string;
      readonly clerkToken: string;
      readonly liveActivitiesEnabled: boolean;
    },
    registry: AtomRegistry.AtomRegistry,
  ) {
    yield* ensureRelayClient(input.connection);
    yield* linkEnvironmentToCloudWithPreference(input).pipe(
      Effect.mapError((cause) => new PhoneSharingError({ message: cause.message, cause })),
      // The relay may have linked before the server failed to take the config.
      Effect.tapError(() =>
        unlinkServer(input.connection).pipe(
          Effect.andThen(
            deregisterManagedRelayEnvironment(registry, {
              accountId: input.accountId,
              environmentId: input.connection.environmentId,
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
    yield* Effect.sync(() => setSharingRecord({ accountId: input.accountId }));
  }),
});

/** Off: stops the tunnel, signs out other clients, and takes the phone off the account. */
export const stopSharingPhoneServer = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:stop-sharing",
  execute: Effect.fn("PhoneSharing.stop")(function* (
    input: { readonly connection: SavedRemoteConnection; readonly owner: string | null },
    registry: AtomRegistry.AtomRegistry,
  ) {
    const signedIn = registry.get(managedRelaySessionAtom)?.accountId ?? null;
    const { connection, owner } = input;
    yield* stopServerSharing(connection, {
      pairingLinkIds: pairingLinkIds(connection.environmentId),
      deregister: Effect.suspend(
        (): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> => {
          if (owner === null) return Effect.sync(() => setSharingRecord(undefined));
          return owner === signedIn
            ? deregister(registry, owner, connection.environmentId)
            : Effect.fail(new PhoneSharingError({ message: PHONE_STILL_LISTED }));
        },
      ),
    });
  }),
});

/** Ends a share on the server alone, for when no account is available to deregister with. */
const stopServerWithoutAccount = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:stop-without-account",
  execute: Effect.fn("PhoneSharing.stopWithoutAccount")(function* (
    connection: SavedRemoteConnection,
  ) {
    const sharing = yield* readSharing(connection);
    if (!sharing.shared) return null;
    yield* stopServerSharing(connection, {
      pairingLinkIds: pairingLinkIds(connection.environmentId),
      deregister: Effect.void,
    });
    return sharing.cloudUserId;
  }),
});

const deregisterPhone = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:deregister",
  execute: (
    input: { readonly accountId: string; readonly environmentId: EnvironmentId },
    registry,
  ) => deregister(registry, input.accountId, input.environmentId),
});

/**
 * Signing out or switching accounts ends sharing, as the phone would otherwise stay open to an
 * account this app no longer uses. A server that's down finishes it when it next connects.
 * The account's listing stays until that account signs in here again: deregistering needs it.
 */
export async function stopPhoneSharingAfterSignOut(): Promise<void> {
  const settings = appAtomRegistry.get(phoneServerSettingsAtom);
  if (settings === null) return;
  const connection = appAtomRegistry.get(savedRemoteConnectionAtom(settings.environmentId));
  const result =
    connection === null
      ? null
      : await runAtomCommand(appAtomRegistry, stopServerWithoutAccount, connection, {
          reportFailure: false,
        });
  if (result !== null && AsyncResult.isSuccess(result)) {
    const owner = result.value ?? settings.sharing?.accountId;
    setSharingRecord(owner === undefined ? undefined : { accountId: owner });
  } else if (settings.sharing) {
    setSharingRecord({ ...settings.sharing, pendingStop: true });
  }
}

/** Finishes a sign-out's stop once the phone's server is reachable again. */
export async function finishPendingSharingStop(): Promise<void> {
  const settings = appAtomRegistry.get(phoneServerSettingsAtom);
  if (!settings?.sharing?.pendingStop) return;
  const connection = appAtomRegistry.get(savedRemoteConnectionAtom(settings.environmentId));
  if (connection === null) return;
  const result = await runAtomCommand(appAtomRegistry, stopServerWithoutAccount, connection, {
    reportFailure: false,
  });
  if (AsyncResult.isSuccess(result)) setSharingRecord({ accountId: settings.sharing.accountId });
}

/** Retries a deregistration that failed earlier, once the server is off and the account is back. */
export async function retryPhoneDeregistration(): Promise<void> {
  const settings = appAtomRegistry.get(phoneServerSettingsAtom);
  const record = settings?.sharing;
  if (!settings || !record || record.pendingStop) return;
  if (appAtomRegistry.get(managedRelaySessionAtom)?.accountId !== record.accountId) return;
  await runAtomCommand(
    appAtomRegistry,
    deregisterPhone,
    { accountId: record.accountId, environmentId: settings.environmentId },
    { reportFailure: false },
  );
}

/**
 * Remove and Reinstall delete the server's link along with Ubuntu, so a shared phone comes off
 * the account first. Returns what the user has to do by hand when that isn't possible, such as
 * when they're signed out. A server that's down doesn't matter: Ubuntu's about to go anyway.
 */
export async function releasePhoneSharing(
  connection: SavedRemoteConnection | null,
): Promise<string | null> {
  const settings = appAtomRegistry.get(phoneServerSettingsAtom);
  const read =
    connection === null
      ? null
      : await runAtomCommand(appAtomRegistry, readPhoneSharing, connection, {
          reportFailure: false,
        });
  const sharing = read !== null && AsyncResult.isSuccess(read) ? read.value : null;
  const record = settings?.sharing;
  if (!sharing?.shared && !record) return null;
  if (sharing?.shared && connection !== null) {
    await runAtomCommand(appAtomRegistry, stopServerWithoutAccount, connection, {
      reportFailure: false,
    });
  }
  const owner = (sharing?.shared ? sharing.cloudUserId : null) ?? record?.accountId ?? null;
  if (owner === null) return null;
  const environmentId = connection?.environmentId ?? settings?.environmentId;
  if (environmentId === undefined) return PHONE_STILL_LISTED;
  if (appAtomRegistry.get(managedRelaySessionAtom)?.accountId !== owner) return PHONE_STILL_LISTED;
  const removed = await runAtomCommand(
    appAtomRegistry,
    deregisterPhone,
    { accountId: owner, environmentId },
    { reportFailure: false },
  );
  return AsyncResult.isSuccess(removed) ? null : PHONE_STILL_LISTED;
}
