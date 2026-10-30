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
  readonly saveRecord: (record: PhoneSharingRecord | null) => void;
  readonly phoneEnvironmentId: () => EnvironmentId | null;
  readonly connectionFor: (environmentId: EnvironmentId) => SavedRemoteConnection | null;
  readonly signedInAccount: () => string | null;
  /** Null when the server can't answer. */
  readonly readSharing: (connection: SavedRemoteConnection) => Promise<PhoneSharing | null>;
  /** Each returns the failure's text, or null. */
  readonly ensureRelayClient: (connection: SavedRemoteConnection) => Promise<string | null>;
  /** Idempotent, so an unfinished stop can run again from the start. */
  readonly stopOnServer: (
    connection: SavedRemoteConnection,
    options: { readonly revokeAccess: boolean },
  ) => Promise<string | null>;
  readonly deregister: (accountId: string, environmentId: EnvironmentId) => Promise<string | null>;
}

/**
 * Every change to sharing runs here, one at a time, from a record saved before the work starts.
 * A sign-out during a share therefore stops what the share set up, and anything left unfinished
 * by a failure, a dead server or a killed app is picked up by the next `reconcile`.
 */
export function createPhoneSharingController(effects: PhoneSharingEffects) {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      await effects.hydrated();
      return task();
    });
    queue = run.catch(() => undefined);
    return run;
  };

  /** Works a stopping or listed record as far as it can go. Null means nothing is left to do. */
  const settle = async (): Promise<string | null> => {
    let record = effects.loadRecord();
    if (record === null || record.phase === "on") return null;
    if (record.phase === "stopping") {
      const connection = effects.connectionFor(record.environmentId);
      if (connection === null) return STOP_UNFINISHED;
      const failure = await effects.stopOnServer(connection, {
        revokeAccess: record.failedShare !== true,
      });
      if (failure !== null) return failure;
      record = { ...record, phase: "listed" };
      effects.saveRecord(record);
    }
    // A failed share may never have reached the account, so its listing is only worth one try.
    const failedShare = record.failedShare === true;
    const owner = record.accountId;
    if (owner === null) {
      effects.saveRecord(null);
      return null;
    }
    const removed =
      effects.signedInAccount() === owner
        ? (await effects.deregister(owner, record.environmentId)) === null
        : false;
    if (removed || failedShare) {
      effects.saveRecord(null);
      return null;
    }
    return PHONE_STILL_LISTED;
  };

  /** Sharing on the server counts even with no record, such as a link made some other way. */
  const markStopping = async () => {
    const record = effects.loadRecord();
    const environmentId = record?.environmentId ?? effects.phoneEnvironmentId();
    if (environmentId === null) return;
    const connection = effects.connectionFor(environmentId);
    const sharing = connection === null ? null : await effects.readSharing(connection);
    const shared = sharing?.shared === true ? sharing : null;
    if (record === null) {
      if (shared !== null) {
        effects.saveRecord({ environmentId, accountId: shared.cloudUserId, phase: "stopping" });
      }
      return;
    }
    if (record.phase === "on" || shared !== null) {
      effects.saveRecord({
        ...record,
        accountId: shared?.cloudUserId ?? record.accountId,
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
        await settle();
        const notReady = await effects.ensureRelayClient(connection);
        if (notReady !== null) return notReady;
        const environmentId = connection.environmentId;
        effects.saveRecord({ environmentId, accountId, phase: "on" });
        const failure = await link();
        if (failure !== null) {
          effects.saveRecord({ environmentId, accountId, phase: "stopping", failedShare: true });
          await settle();
          return failure;
        }
        if (effects.signedInAccount() !== accountId) {
          effects.saveRecord({ environmentId, accountId, phase: "stopping" });
          await settle();
          return "You signed out of T3 Connect, so this phone wasn't shared.";
        }
        return null;
      }),

    /** Off, and signing out or switching accounts. Null when nothing is left to do. */
    stop: () =>
      enqueue(async () => {
        await markStopping();
        return settle();
      }),

    /** Retries unfinished work, and notices a share a killed app never finished. */
    reconcile: () =>
      enqueue(async () => {
        const record = effects.loadRecord();
        if (record?.phase === "on") {
          const connection = effects.connectionFor(record.environmentId);
          const sharing = connection === null ? null : await effects.readSharing(connection);
          if (sharing?.shared === false) {
            effects.saveRecord({ ...record, phase: "stopping", failedShare: true });
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
          effects.saveRecord({ ...record, phase: "listed" });
          await settle();
        }
        return effects.loadRecord() === null ? null : PHONE_STILL_LISTED;
      }),

    /** Before forgetting the connection, which is the only way to reach the server. */
    stopBeforeForgetting: () =>
      enqueue(async () => {
        await markStopping();
        const failure = await settle();
        return effects.loadRecord()?.phase === "stopping" ? failure : null;
      }),
  };
}
