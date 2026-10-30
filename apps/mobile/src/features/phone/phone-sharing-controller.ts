import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import type { PhoneSharingRecord } from "../../persistence/mobile-preferences";
import { PHONE_STILL_LISTED, type PhoneSharing } from "./phone-sharing";

const STOP_UNFINISHED =
  "Sharing hasn't finished stopping: other devices may still have access. T3 Code tries again when this phone's server answers.";

export interface PhoneSharingEffects {
  /** Resolves once saved preferences are loaded, so a decision never reads an empty record. */
  readonly hydrated: () => Promise<void>;
  readonly loadRecord: () => PhoneSharingRecord | null;
  /** Rejects when the record couldn't be saved. */
  readonly saveRecord: (record: PhoneSharingRecord | null) => Promise<void>;
  readonly phoneEnvironmentId: () => EnvironmentId | null;
  readonly connectionFor: (environmentId: EnvironmentId) => SavedRemoteConnection | null;
  readonly signedInAccount: () => string | null;
  /** Null when the server can't answer. Every effect here has its own deadline. */
  readonly readSharing: (connection: SavedRemoteConnection) => Promise<PhoneSharing | null>;
  /** Each returns the failure's text, or null. */
  readonly ensureRelayClient: (connection: SavedRemoteConnection) => Promise<string | null>;
  /** Idempotent, so an unfinished stop can run again from the start. */
  readonly stopOnServer: (connection: SavedRemoteConnection) => Promise<string | null>;
  /** Null too when the account no longer lists the phone. */
  readonly deregister: (accountId: string, environmentId: EnvironmentId) => Promise<string | null>;
}

/**
 * Every change to sharing runs here, one at a time, from a record saved before the work starts,
 * so a sign-out during a share stops what it set up and `reconcile` picks up anything unfinished.
 * A stop always signs out other clients: a "failed" share may have reached the server.
 */
export function createPhoneSharingController(effects: PhoneSharingEffects) {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (task: () => Promise<string | null>): Promise<string | null> => {
    const run = queue.then(async () => {
      await effects.hydrated();
      return task().catch((error: unknown) =>
        error instanceof Error ? error.message : "Couldn't update phone sharing.",
      );
    });
    queue = run;
    return run;
  };

  /** Works a stopping or listed record as far as it can go. Null means nothing is left to do. */
  const settle = async (): Promise<string | null> => {
    let record = effects.loadRecord();
    if (record === null || record.phase === "on") return null;
    if (record.phase === "stopping") {
      const connection = effects.connectionFor(record.environmentId);
      if (connection === null) return STOP_UNFINISHED;
      const failure = await effects.stopOnServer(connection);
      if (failure !== null) return failure;
      record = { ...record, phase: "listed" };
      await effects.saveRecord(record);
    }
    const owner = record.accountId;
    if (owner !== null) {
      if (effects.signedInAccount() !== owner) return PHONE_STILL_LISTED;
      if ((await effects.deregister(owner, record.environmentId)) !== null) {
        return PHONE_STILL_LISTED;
      }
    }
    await effects.saveRecord(null);
    return null;
  };

  /** An unreadable server counts as shared until proven otherwise: off is the claim to prove. */
  const markStopping = async () => {
    const record = effects.loadRecord();
    const environmentId = record?.environmentId ?? effects.phoneEnvironmentId();
    if (environmentId === null) return;
    if (record?.phase === "on") await effects.saveRecord({ ...record, phase: "stopping" });
    const connection = effects.connectionFor(environmentId);
    const sharing = connection === null ? null : await effects.readSharing(connection);
    const current = effects.loadRecord();
    if (current === null) {
      if (sharing === null) {
        await effects.saveRecord({ environmentId, accountId: null, phase: "stopping" });
      } else if (sharing.shared) {
        await effects.saveRecord({
          environmentId,
          accountId: sharing.cloudUserId,
          phase: "stopping",
        });
      }
    } else if (sharing?.shared === true) {
      await effects.saveRecord({
        ...current,
        accountId: sharing.cloudUserId ?? current.accountId,
        phase: "stopping",
      });
    }
  };

  return {
    /** Null when the share took; otherwise why it didn't, with its setup already undone. */
    share: (
      connection: SavedRemoteConnection,
      accountId: string,
      link: () => Promise<string | null>,
    ) =>
      enqueue(async () => {
        const unfinished = await settle();
        if (effects.loadRecord()?.phase === "stopping") return unfinished ?? STOP_UNFINISHED;
        const sharing = await effects.readSharing(connection);
        if (sharing === null) return "Couldn't check whether this phone is already shared.";
        if (sharing.shared) return "This phone is already shared.";
        const notReady = await effects.ensureRelayClient(connection);
        if (notReady !== null) return notReady;
        const environmentId = connection.environmentId;
        await effects.saveRecord({ environmentId, accountId, phase: "on" });
        const failure = await link();
        if (failure === null && effects.signedInAccount() === accountId) return null;
        await effects.saveRecord({ environmentId, accountId, phase: "stopping" });
        await settle();
        return failure ?? "You signed out of T3 Connect, so this phone wasn't shared.";
      }),

    /** Off, and signing out or switching accounts. Null when nothing is left to do. */
    stop: () =>
      enqueue(async () => {
        await markStopping();
        return settle();
      }),

    /**
     * Retries unfinished work. Also ends a share that a killed app left behind, either half set
     * up or still open to an account this app has since left.
     */
    reconcile: () =>
      enqueue(async () => {
        const record = effects.loadRecord();
        if (record?.phase === "on") {
          const account = effects.signedInAccount();
          const connection = effects.connectionFor(record.environmentId);
          const sharing = connection === null ? null : await effects.readSharing(connection);
          if ((account !== null && account !== record.accountId) || sharing?.shared === false) {
            await effects.saveRecord({ ...record, phase: "stopping" });
          }
        }
        return settle();
      }),

    /** Before Ubuntu is deleted: only the account's listing can outlive it. */
    release: () =>
      enqueue(async () => {
        await markStopping();
        await settle();
        const record = effects.loadRecord();
        if (record?.phase === "stopping") {
          await effects.saveRecord({ ...record, phase: "listed" });
          await settle();
        }
        return effects.loadRecord() === null ? null : PHONE_STILL_LISTED;
      }),

    /** Before forgetting the connection, which is the only way to reach the server. */
    stopBeforeForgetting: () =>
      enqueue(async () => {
        await markStopping();
        const failure = await settle();
        return effects.loadRecord()?.phase === "stopping" ? (failure ?? STOP_UNFINISHED) : null;
      }),
  };
}
