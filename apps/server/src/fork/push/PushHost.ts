import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  makeAggregateState,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
} from "../../../../../infra/relay/src/agentActivity/agentActivityAggregate.ts";
import {
  isExpiredAgentActivityState,
  isTerminalPhase,
} from "../../../../../infra/relay/src/agentActivity/agentActivityPayloads.ts";
import {
  androidActivityData,
  fitFcmData,
} from "../../../../../infra/relay/src/agentActivity/fcmPayloads.ts";
import { androidAlertForAggregate, androidAlertForState } from "./androidAlerts.ts";
import { PushHostFcm } from "./fcm.ts";
import * as PushHostStore from "./PushHostStore.ts";

export interface PushDeviceRegistration {
  readonly deviceId: string;
  readonly userId: string;
  readonly token: string;
  readonly packageName: string | null;
  readonly label: string;
  readonly preferences: RelayAgentAwarenessPreferences;
}

export interface PushHostStatus {
  readonly devices: ReadonlyArray<{
    readonly deviceId: string;
    readonly label: string;
    readonly registeredAt: string;
    readonly lastSentAt: string | null;
    readonly lastError: string | null;
  }>;
  readonly peers: ReadonlyArray<PushHostStore.PushPeer>;
}

/**
 * A private relay for one owner: it keeps the latest agent activity of this server and its
 * linked peers, and sends Android devices the same FCM payloads upstream's relay sends.
 */
export class PushHost extends Context.Service<
  PushHost,
  {
    /** Whether this server holds an FCM key and acts as the push host. */
    readonly enabled: boolean;
    readonly ingest: (input: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<ReadonlyArray<string>>;
    readonly registerDevice: (input: PushDeviceRegistration) => Effect.Effect<void>;
    readonly unregisterDevice: (deviceId: string) => Effect.Effect<boolean>;
    /** Sends a test alert; fails with FCM's answer when it is refused. */
    readonly sendTest: (deviceId: string) => Effect.Effect<boolean, string>;
    readonly status: Effect.Effect<PushHostStatus>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fork/push/PushHost") {}

type Delivery =
  | {
      readonly kind: "state";
      readonly deviceId: string;
      readonly state: RelayAgentActivityState | null;
    }
  | { readonly kind: "replay"; readonly deviceId: string };

const SEND_RETRY_DELAYS = ["1 second", "4 seconds", "16 seconds"] as const;

const rowKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

const keepRow = (row: RelayAgentActivityState, nowMs: number) =>
  isTerminalPhase(row)
    ? nowMs - Date.parse(row.updatedAt) <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS
    : !isExpiredAgentActivityState(row, nowMs);

const describeError = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const make = Effect.gen(function* () {
  const fcm = yield* PushHostFcm;
  const store = yield* PushHostStore.PushHostStore;
  const digest = yield* Digest.Digest;
  const sha256Hex = (value: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(value))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const send = fcm.send;
  const stateRef = yield* Ref.make(yield* store.load);
  const writes = yield* Semaphore.make(1);

  const persist = writes.withPermits(1)(Ref.get(stateRef).pipe(Effect.flatMap(store.save)));

  const updateDevice = (
    deviceId: string,
    f: (device: PushHostStore.PushDevice) => PushHostStore.PushDevice | null,
  ) =>
    Ref.update(stateRef, (state) => ({
      ...state,
      devices: state.devices.flatMap((device) => {
        if (device.deviceId !== deviceId) return [device];
        const next = f(device);
        return next === null ? [] : [next];
      }),
    }));

  // A send answers for the token it went to; a registration replaced meanwhile keeps its own state.
  const updateRegistration = (
    sentTo: PushHostStore.PushDevice,
    f: (device: PushHostStore.PushDevice) => PushHostStore.PushDevice | null,
  ) =>
    updateDevice(sentTo.deviceId, (current) =>
      current.token === sentTo.token ? f(current) : current,
    );

  const sendTo = Effect.fn("PushHost.sendTo")(function* (
    device: PushHostStore.PushDevice,
    input: { readonly data: Record<string, string>; readonly alert: boolean },
  ) {
    if (send === null) return { unregistered: false };
    return yield* send({
      token: device.token,
      packageName: device.packageName,
      alert: input.alert,
      data: fitFcmData(input.data),
    });
  });

  // Ingest has already answered its peer, so a send FCM could not take is retried here, and only
  // while the registration still holds the token it was meant for.
  const sendWithRetries = Effect.fn("PushHost.sendWithRetries")(function* (
    device: PushHostStore.PushDevice,
    input: { readonly data: Record<string, string>; readonly alert: boolean },
  ) {
    for (let attempt = 0; ; attempt++) {
      const result = yield* sendTo(device, input).pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      const error = result.failure;
      const delay = SEND_RETRY_DELAYS[attempt];
      const retryable = error.status === null || error.status === 429 || error.status >= 500;
      if (!retryable || delay === undefined) return yield* error;
      yield* Effect.sleep(delay);
      const current = (yield* Ref.get(stateRef)).devices.find(
        (candidate) => candidate.deviceId === device.deviceId,
      );
      if (current?.token !== device.token) return yield* error;
    }
  });

  // Mirrors FcmDeliveries.process in infra/relay, with every environment allowed to alert.
  const deliver = Effect.fn("PushHost.deliver")(function* (delivery: Delivery) {
    const state = yield* Ref.get(stateRef);
    const device = state.devices.find((candidate) => candidate.deviceId === delivery.deviceId);
    if (device === undefined) return;
    const now = yield* DateTime.now;
    const nowMs = now.epochMilliseconds;
    const preferences = device.preferences;
    const jobState = delivery.kind === "state" ? delivery.state : null;
    const aggregate = makeAggregateState({
      activeStates: preferences.liveActivitiesEnabled ? state.rows : [],
      terminalState: null,
      nowMs,
    });
    const previousAggregate = device.lastAggregate;
    // A deletion repaints the card but keeps the baseline, or it would swallow another thread's
    // pending transition that it happened to read.
    const acknowledge = jobState !== null || delivery.kind === "replay" || aggregate === null;
    let alert: ReturnType<typeof androidAlertForState | typeof androidAlertForAggregate> = null;
    if (jobState && preferences.notificationsEnabled) {
      const row = state.rows.find(
        (candidate) =>
          candidate.environmentId === jobState.environmentId &&
          candidate.threadId === jobState.threadId,
      );
      const current =
        row !== undefined && row.phase === jobState.phase && row.updatedAt === jobState.updatedAt
          ? row
          : null;
      if (!previousAggregate && current === null) return;
      if (preferences.liveActivitiesEnabled && previousAggregate && aggregate) {
        alert = androidAlertForAggregate({
          previousAggregate,
          nextAggregate: aggregate,
          preferences,
          nowMs,
        });
      } else if (current !== null && !isExpiredAgentActivityState(current, nowMs)) {
        alert = androidAlertForState(current, preferences, nowMs);
      }
    }
    const displayed = preferences.liveActivitiesEnabled ? aggregate : null;
    if (!displayed && !alert && !previousAggregate && jobState !== null) return;
    const data: Record<string, string> = {
      t3_kind: "agent_activity",
      device_id: device.deviceId,
      user_id: device.userId,
      updated_at: String(nowMs),
      ...androidActivityData(displayed),
      ...alert,
    };
    // Hash the full stable group identity to stay within the payload budget.
    if (alert) data.alert_id = yield* sha256Hex(alert.alert_id);
    const sentAt = DateTime.formatIso(now);
    const result = yield* sendWithRetries(device, { data, alert: alert !== null }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Push host could not send to a device", {
          deviceId: device.deviceId,
          status: error.status,
          error: error.message,
        }).pipe(
          Effect.andThen(
            updateRegistration(device, (current) => ({ ...current, lastError: error.message })),
          ),
          Effect.as(null),
        ),
      ),
    );
    if (result === null) return yield* persist;
    if (result.unregistered) {
      yield* Effect.logInfo("Push host dropped a device FCM no longer knows", {
        deviceId: device.deviceId,
      });
      yield* updateRegistration(device, () => null);
      return yield* persist;
    }
    yield* Effect.logInfo("Push host sent agent activity", {
      deviceId: device.deviceId,
      alert: alert !== null,
      activeCount: displayed?.activeCount ?? 0,
    });
    yield* updateRegistration(device, (current) => ({
      ...current,
      lastAggregate: !acknowledge
        ? current.lastAggregate
        : preferences.liveActivitiesEnabled
          ? aggregate
          : null,
      lastSentAt: sentAt,
      lastError: null,
    }));
    yield* persist;
  });

  const worker = yield* makeDrainableWorker(deliver);

  const ingest: PushHost["Service"]["ingest"] = Effect.fn("PushHost.ingest")(function* (input) {
    const now = yield* DateTime.now;
    const key = rowKey(input.environmentId, input.threadId);
    const state = yield* Ref.updateAndGet(stateRef, (current) => ({
      ...current,
      rows: [
        ...current.rows.filter(
          (row) =>
            rowKey(row.environmentId, row.threadId) !== key && keepRow(row, now.epochMilliseconds),
        ),
        ...(input.state === null ? [] : [input.state]),
      ],
      peers: [
        ...current.peers.filter((peer) => peer.environmentId !== input.environmentId),
        { environmentId: input.environmentId, lastHeardAt: DateTime.formatIso(now) },
      ],
    }));
    yield* persist;
    yield* Effect.forEach(
      state.devices,
      (device) => worker.enqueue({ kind: "state", deviceId: device.deviceId, state: input.state }),
      { discard: true },
    );
    return state.devices.map((device) => device.deviceId);
  });

  const registerDevice: PushHost["Service"]["registerDevice"] = Effect.fn(
    "PushHost.registerDevice",
  )(function* (input) {
    const registeredAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(stateRef, (state) => {
      const existing = state.devices.find((device) => device.deviceId === input.deviceId);
      // A new token or identity is a fresh native store, so its card baseline starts over.
      const sameTarget =
        existing !== undefined &&
        existing.token === input.token &&
        existing.userId === input.userId;
      const device: PushHostStore.PushDevice = {
        ...input,
        registeredAt: existing?.registeredAt ?? registeredAt,
        lastAggregate: sameTarget ? existing.lastAggregate : null,
        lastSentAt: existing?.lastSentAt ?? null,
        lastError: sameTarget ? existing.lastError : null,
      };
      return {
        ...state,
        // One phone keeps one registration even when its device ID changes with a reinstall.
        devices: [
          ...state.devices.filter(
            (candidate) => candidate.deviceId !== input.deviceId && candidate.token !== input.token,
          ),
          device,
        ],
      };
    });
    yield* persist;
    yield* worker.enqueue({ kind: "replay", deviceId: input.deviceId });
  });

  const unregisterDevice: PushHost["Service"]["unregisterDevice"] = Effect.fn(
    "PushHost.unregisterDevice",
  )(function* (deviceId) {
    const before = yield* Ref.get(stateRef);
    if (!before.devices.some((device) => device.deviceId === deviceId)) return false;
    yield* updateDevice(deviceId, () => null);
    yield* persist;
    return true;
  });

  const sendTest: PushHost["Service"]["sendTest"] = Effect.fn("PushHost.sendTest")(
    function* (deviceId) {
      const state = yield* Ref.get(stateRef);
      const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
      if (device === undefined) return false;
      const now = yield* DateTime.now;
      const alertId = yield* sha256Hex(`test:${now.epochMilliseconds}`);
      const result = yield* sendTo(device, {
        alert: true,
        data: {
          t3_kind: "agent_activity",
          device_id: device.deviceId,
          user_id: device.userId,
          updated_at: String(now.epochMilliseconds),
          // The card the device already shows, so the test does not disturb it.
          ...androidActivityData(device.lastAggregate),
          alert_id: alertId,
          alert_title: "T3 Code",
          alert_body: "Notifications from your push host work.",
          alert_path: "/",
        },
      }).pipe(Effect.mapError(describeError));
      if (result.unregistered) {
        yield* updateRegistration(device, () => null);
        yield* persist;
        return yield* Effect.fail("FCM no longer knows this device. Register it again.");
      }
      return true;
    },
  );

  const status: PushHost["Service"]["status"] = Ref.get(stateRef).pipe(
    Effect.map((state) => ({
      devices: state.devices.map(({ deviceId, label, registeredAt, lastSentAt, lastError }) => ({
        deviceId,
        label,
        registeredAt,
        lastSentAt,
        lastError,
      })),
      peers: state.peers,
    })),
  );

  return PushHost.of({
    enabled: send !== null,
    ingest,
    registerDevice,
    unregisterDevice,
    sendTest,
    status,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(PushHost, make);
