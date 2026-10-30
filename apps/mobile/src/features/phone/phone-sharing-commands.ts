import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  deregisterManagedRelayEnvironment,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay";
import { request, runStream, subscribe } from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import type { SavedRemoteConnection } from "../../lib/connection";
import type { PhoneSharingRecord } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  phoneServerSettingsAtom,
  phoneSharingRecordAtom,
  setPhoneSharingRecord,
} from "../../state/phone-server-settings";
import { mobilePreferencesAtom } from "../../state/preferences";
import { savedRemoteConnectionAtom } from "../../state/use-remote-environment-registry";
import { linkEnvironmentToCloudWithPreference } from "../cloud/linkEnvironment";
import {
  failWith,
  PhoneSharingError,
  readSharing,
  stopServerSharing,
  waitForReachability,
} from "./phone-sharing";
import { createPhoneSharingController } from "./phone-sharing-controller";

const PAIRING_LINKS_TIMEOUT = Duration.seconds(10);

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
const ensureRelayClient = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:ensure-relay-client",
  execute: Effect.fn("PhoneSharing.ensureRelayClient")(function* (
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
  }),
});

const linkServer = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:link",
  execute: (input: {
    readonly connection: SavedRemoteConnection;
    readonly clerkToken: string;
    readonly liveActivitiesEnabled: boolean;
  }) => linkEnvironmentToCloudWithPreference(input),
});

const stopOnServer = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:stop-sharing",
  execute: (input: {
    readonly connection: SavedRemoteConnection;
    readonly revokeAccess: boolean;
  }) =>
    stopServerSharing(input.connection, {
      revokeAccess: input.revokeAccess,
      pairingLinkIds: pairingLinkIds(input.connection.environmentId),
    }),
});

const deregisterPhone = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:deregister",
  execute: (
    input: { readonly accountId: string; readonly environmentId: EnvironmentId },
    registry,
  ) => deregisterManagedRelayEnvironment(registry, input),
});

export const readPhoneSharing = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:read-sharing",
  execute: readSharing,
});

export const checkPhoneReachability = createRuntimeCommand(connectionAtomRuntime, {
  label: "phone-server:check-reachability",
  execute: waitForReachability,
});

const failureText = (
  result: AsyncResult.AsyncResult<unknown, unknown>,
  fallback: string,
): string | null => {
  if (AsyncResult.isSuccess(result)) return null;
  if (!AsyncResult.isFailure(result)) return fallback;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
};

// Saving is asynchronous, and the controller reads back what it just saved.
let lastSaved: PhoneSharingRecord | null | undefined;

const controller = createPhoneSharingController({
  hydrated: () =>
    Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, mobilePreferencesAtom, {
        suspendOnWaiting: true,
      }).pipe(Effect.ignore),
    ),
  loadRecord: () =>
    lastSaved === undefined ? appAtomRegistry.get(phoneSharingRecordAtom) : lastSaved,
  saveRecord: (record) => {
    lastSaved = record;
    setPhoneSharingRecord(record);
  },
  phoneEnvironmentId: () => appAtomRegistry.get(phoneServerSettingsAtom)?.environmentId ?? null,
  connectionFor: (environmentId) => appAtomRegistry.get(savedRemoteConnectionAtom(environmentId)),
  signedInAccount: () => appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null,
  readSharing: async (connection) => {
    const result = await runAtomCommand(appAtomRegistry, readPhoneSharing, connection, {
      reportFailure: false,
    });
    return AsyncResult.isSuccess(result) ? result.value : null;
  },
  ensureRelayClient: async (connection) =>
    failureText(
      await runAtomCommand(appAtomRegistry, ensureRelayClient, connection, {
        reportFailure: false,
      }),
      "Couldn't set up the T3 Connect relay client.",
    ),
  stopOnServer: async (connection, { revokeAccess }) =>
    failureText(
      await runAtomCommand(
        appAtomRegistry,
        stopOnServer,
        { connection, revokeAccess },
        { reportFailure: false },
      ),
      "Couldn't stop sharing this phone.",
    ),
  deregister: async (accountId, environmentId) =>
    failureText(
      await runAtomCommand(
        appAtomRegistry,
        deregisterPhone,
        { accountId, environmentId },
        { reportFailure: false },
      ),
      "Couldn't remove this phone from T3 Connect.",
    ),
});

/**
 * Links the phone's server to the signed-in T3 Connect account with a managed tunnel. The
 * server keeps listening on loopback; cloudflared reaches it there and connects out.
 */
export const sharePhone = (input: {
  readonly connection: SavedRemoteConnection;
  readonly accountId: string;
  readonly clerkToken: string;
  readonly liveActivitiesEnabled: boolean;
}) =>
  controller.share(input.connection, input.accountId, async () =>
    failureText(
      await runAtomCommand(appAtomRegistry, linkServer, input, { reportFailure: false }),
      "Couldn't share this phone.",
    ),
  );

export const stopPhoneSharing = () => controller.stop();
export const reconcilePhoneSharing = () => controller.reconcile();
export const releasePhoneSharing = () => controller.release();
export const stopPhoneSharingBeforeForgetting = () => controller.stopBeforeForgetting();

/**
 * Signing out or switching accounts ends sharing, as the phone would otherwise stay open to an
 * account this app no longer uses. The listing stays until that account signs in here again:
 * deregistering needs its sign-in, and Clerk's profile view has already ended it by now.
 */
export const stopPhoneSharingAfterSignOut = () => controller.stop();
