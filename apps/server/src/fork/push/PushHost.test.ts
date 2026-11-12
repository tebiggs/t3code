import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FcmClientError, type FcmSend, PushHostFcm } from "./fcm.ts";
import * as PushHost from "./PushHost.ts";
import * as PushHostStore from "./PushHostStore.ts";

const running: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env-desktop"),
  threadId: ThreadId.make("thread-1"),
  projectTitle: "Project",
  threadTitle: "Fix notifications",
  phase: "running",
  headline: "Working",
  modelTitle: "Claude",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env-desktop/thread-1",
};
const waiting: RelayAgentActivityState = {
  ...running,
  phase: "waiting_for_approval",
  headline: "Needs approval",
  updatedAt: "1970-01-01T00:00:01.000Z",
};

const registration: PushHost.PushDeviceRegistration = {
  deviceId: "device-1",
  userId: "t3-fork:env-host",
  token: "fcm-token",
  packageName: "com.example.t3code",
  label: "Phone",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

type Sent = Parameters<FcmSend>[0];

const harness = (options: { readonly unregistered?: boolean; readonly failWith?: number } = {}) => {
  const sent: Sent[] = [];
  const send: FcmSend = (input) =>
    options.failWith !== undefined
      ? Effect.fail(new FcmClientError({ operation: "send", status: options.failWith }))
      : Effect.sync(() => {
          sent.push(input);
          return { unregistered: options.unregistered === true };
        });
  const fcm = Layer.succeed(PushHostFcm, PushHostFcm.of({ send, projectId: "project" }));
  return { sent, fcm };
};

const hostLayer = (
  fcm: Layer.Layer<PushHostFcm>,
  store: Layer.Layer<PushHostStore.PushHostStore>,
) => PushHost.layer.pipe(Layer.provide(Layer.mergeAll(fcm, store, NodeCrypto.layer)));

describe("PushHost", () => {
  it.effect("shows the card and alerts once when a thread starts waiting", () => {
    const { sent, fcm } = harness();
    return Effect.gen(function* () {
      const host = yield* PushHost.PushHost;
      yield* host.registerDevice(registration);
      yield* host.drain;
      yield* host.ingest({
        environmentId: running.environmentId,
        threadId: running.threadId,
        state: running,
      });
      yield* host.drain;
      yield* host.ingest({
        environmentId: waiting.environmentId,
        threadId: waiting.threadId,
        state: waiting,
      });
      yield* host.drain;
      yield* host.ingest({
        environmentId: waiting.environmentId,
        threadId: waiting.threadId,
        state: waiting,
      });
      yield* host.drain;

      assert.deepStrictEqual(
        sent.map((message) => [message.alert, message.data.activity_active_count]),
        [
          [false, "0"],
          [false, "1"],
          [true, "1"],
          [false, "1"],
        ],
      );
      const alerted = sent[2]!;
      assert.strictEqual(alerted.token, "fcm-token");
      assert.strictEqual(alerted.packageName, "com.example.t3code");
      assert.strictEqual(alerted.data.device_id, "device-1");
      assert.strictEqual(alerted.data.user_id, "t3-fork:env-host");
      assert.strictEqual(alerted.data.alert_path, "/threads/env-desktop/thread-1");
      assert.match(alerted.data.alert_id ?? "", /^[0-9a-f]{64}$/);
    }).pipe(Effect.provide(hostLayer(fcm, PushHostStore.layerMemory())));
  });

  it.effect("drops a device FCM reports as unregistered", () => {
    const { fcm } = harness({ unregistered: true });
    return Effect.gen(function* () {
      const host = yield* PushHost.PushHost;
      yield* host.registerDevice(registration);
      yield* host.drain;
      assert.deepStrictEqual((yield* host.status).devices, []);
    }).pipe(Effect.provide(hostLayer(fcm, PushHostStore.layerMemory())));
  });

  it.effect("records a refused send on the device and keeps it", () => {
    const { fcm } = harness({ failWith: 400 });
    return Effect.gen(function* () {
      const host = yield* PushHost.PushHost;
      yield* host.registerDevice(registration);
      yield* host.drain;
      const [device] = (yield* host.status).devices;
      assert.strictEqual(device?.lastError, "FCM send failed (400).");
    }).pipe(Effect.provide(hostLayer(fcm, PushHostStore.layerMemory())));
  });

  it.effect("keeps devices and rows across a restart", () => {
    const first = harness();
    const second = harness();
    const store = PushHostStore.layerMemory();
    return Effect.gen(function* () {
      const memory = yield* PushHostStore.PushHostStore;
      const storeLayer = Layer.succeed(PushHostStore.PushHostStore, memory);
      yield* Effect.gen(function* () {
        const host = yield* PushHost.PushHost;
        yield* host.registerDevice(registration);
        yield* host.ingest({
          environmentId: running.environmentId,
          threadId: running.threadId,
          state: running,
        });
        yield* host.drain;
      }).pipe(Effect.provide(hostLayer(first.fcm, storeLayer)));
      yield* Effect.gen(function* () {
        const host = yield* PushHost.PushHost;
        const status = yield* host.status;
        assert.deepStrictEqual(
          status.devices.map((device) => device.deviceId),
          ["device-1"],
        );
        assert.deepStrictEqual(
          status.peers.map((peer) => peer.environmentId),
          ["env-desktop"],
        );
        // Registering again replays the stored card without alerting.
        yield* host.registerDevice(registration);
        yield* host.drain;
      }).pipe(Effect.provide(hostLayer(second.fcm, storeLayer)));
      assert.deepStrictEqual(
        second.sent.map((message) => [message.alert, message.data.activity_active_count]),
        [[false, "1"]],
      );
    }).pipe(Effect.provide(store));
  });

  it.effect("clears a thread's row when its state is removed", () => {
    const { sent, fcm } = harness();
    return Effect.gen(function* () {
      const host = yield* PushHost.PushHost;
      yield* host.registerDevice(registration);
      yield* host.drain;
      yield* host.ingest({
        environmentId: running.environmentId,
        threadId: running.threadId,
        state: running,
      });
      yield* host.drain;
      yield* host.ingest({
        environmentId: running.environmentId,
        threadId: running.threadId,
        state: null,
      });
      yield* host.drain;
      assert.deepStrictEqual(
        sent.map((message) => message.data.active),
        ["false", "true", "false"],
      );
    }).pipe(Effect.provide(hostLayer(fcm, PushHostStore.layerMemory())));
  });

  it.effect("is off without an FCM key", () =>
    Effect.gen(function* () {
      const host = yield* PushHost.PushHost;
      assert.isFalse(host.enabled);
    }).pipe(
      Effect.provide(
        hostLayer(
          Layer.succeed(PushHostFcm, PushHostFcm.of({ send: null, projectId: null })),
          PushHostStore.layerMemory(),
        ),
      ),
    ),
  );
});
