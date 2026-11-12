import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

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

  it.effect("keeps a token registered while the previous token's send is refused", () => {
    const sent: Sent[] = [];
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const send: FcmSend = (input) =>
        input.token === "token-a"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ unregistered: true }),
            )
          : Effect.sync(() => {
              sent.push(input);
              return { unregistered: false };
            });
      const fcm = Layer.succeed(PushHostFcm, PushHostFcm.of({ send, projectId: "project" }));
      yield* Effect.gen(function* () {
        const host = yield* PushHost.PushHost;
        yield* host.registerDevice({ ...registration, token: "token-a" });
        yield* Deferred.await(started);
        yield* host.registerDevice({ ...registration, token: "token-b" });
        yield* Deferred.succeed(release, undefined);
        yield* host.drain;
        assert.deepStrictEqual(
          (yield* host.status).devices.map((device) => device.deviceId),
          ["device-1"],
        );
        assert.deepStrictEqual(
          sent.map((message) => message.token),
          ["token-b"],
        );
      }).pipe(Effect.provide(hostLayer(fcm, PushHostStore.layerMemory())));
    });
  });

  it.effect("retries a send FCM could not take, then gives up after a bounded number", () => {
    const sent: Sent[] = [];
    let failures = 0;
    const send: FcmSend = (input) =>
      failures > 0
        ? Effect.sync(() => void failures--).pipe(
            Effect.andThen(Effect.fail(new FcmClientError({ operation: "send", status: 503 }))),
          )
        : Effect.sync(() => {
            sent.push(input);
            return { unregistered: false };
          });
    const fcm = Layer.succeed(PushHostFcm, PushHostFcm.of({ send, projectId: "project" }));
    return Effect.gen(function* () {
      const host = yield* PushHost.PushHost;
      yield* host.registerDevice(registration);
      yield* host.drain;
      failures = 2;
      yield* host.ingest({
        environmentId: waiting.environmentId,
        threadId: waiting.threadId,
        state: waiting,
      });
      const drained = yield* Effect.forkChild(host.drain);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(drained);
      assert.deepStrictEqual(
        sent.map((message) => message.alert),
        [false, true],
      );
      assert.isNull((yield* host.status).devices[0]?.lastError ?? null);

      failures = 100;
      yield* host.ingest({
        environmentId: waiting.environmentId,
        threadId: waiting.threadId,
        state: null,
      });
      const gaveUp = yield* Effect.forkChild(host.drain);
      yield* TestClock.adjust("10 minutes");
      yield* Fiber.join(gaveUp);
      assert.isTrue(failures > 90);
      assert.strictEqual((yield* host.status).devices[0]?.lastError, "FCM send failed (503).");
    }).pipe(Effect.provide(hostLayer(fcm, PushHostStore.layerMemory())));
  });

  it.effect.each(["completed", "waiting_for_approval", "waiting_for_input", "failed"] as const)(
    "deleting one thread preserves another thread's %s alert",
    (phase) => {
      const { sent, fcm } = harness();
      const second: RelayAgentActivityState = {
        ...running,
        threadId: ThreadId.make("thread-2"),
        threadTitle: "Second",
        deepLink: "/threads/env-desktop/thread-2",
      };
      const changed = { ...running, phase, updatedAt: "1970-01-01T00:00:02.000Z" };
      return Effect.gen(function* () {
        const host = yield* PushHost.PushHost;
        yield* host.registerDevice(registration);
        yield* host.ingest({
          environmentId: running.environmentId,
          threadId: running.threadId,
          state: running,
        });
        yield* host.ingest({
          environmentId: second.environmentId,
          threadId: second.threadId,
          state: second,
        });
        yield* host.drain;
        // The deletion is queued first but already reads the other thread's change.
        yield* host.ingest({
          environmentId: second.environmentId,
          threadId: second.threadId,
          state: null,
        });
        yield* host.ingest({
          environmentId: changed.environmentId,
          threadId: changed.threadId,
          state: changed,
        });
        yield* host.drain;
        assert.strictEqual(sent.filter((message) => message.alert).length, 1);
        yield* host.ingest({
          environmentId: changed.environmentId,
          threadId: changed.threadId,
          state: changed,
        });
        yield* host.drain;
        assert.strictEqual(sent.filter((message) => message.alert).length, 1);
      }).pipe(Effect.provide(hostLayer(fcm, PushHostStore.layerMemory())));
    },
  );

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
