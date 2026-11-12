import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  secureStore: new Map<string, string>(),
  tokenListeners: [] as Array<(token: { type: string; data: string }) => void>,
  native: { configure: vi.fn(), clear: vi.fn() },
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { android: { package: "com.example.t3code" } }, deviceName: "Phone" },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => mocks.native }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(mocks.secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    mocks.secureStore.set(key, value);
    return Promise.resolve();
  },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: () => Promise.resolve({ granted: true }),
  getDevicePushTokenAsync: () => Promise.resolve({ type: "android", data: "token-1" }),
  addPushTokenListener: (listener: (token: { type: string; data: string }) => void) => {
    mocks.tokenListeners.push(listener);
    return { remove: () => {} };
  },
}));
vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: () => Promise.resolve() }));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: () => Promise.resolve("device-1"),
  loadPreferences: () => Promise.resolve({ liveActivitiesEnabled: true }),
}));

import { configureAndroidAgentNotifications } from "../agent-awareness/androidNotifications";
import { forkOwnsAndroidAgentNotifications } from "./nativeOwnership";
import {
  getForkPushRegistrationState,
  resumeForkPush,
  startForkPushRegistration,
  stopForkPush,
  subscribeForkPushRegistrationState,
} from "./registrar";

const HOST = EnvironmentId.make("env-host");

const settled = (kind: string) =>
  new Promise<void>((resolve) => {
    if (getForkPushRegistrationState().kind === kind) return resolve();
    const unsubscribe = subscribeForkPushRegistrationState(() => {
      if (getForkPushRegistrationState().kind !== kind) return;
      unsubscribe();
      resolve();
    });
  });

describe("fork push registrar", () => {
  it("registers with the push host's identity, follows token rotation, and stops and resumes", async () => {
    const registered: Array<{ token: string; userId: string }> = [];
    const unregistered: string[] = [];
    let onRegister = () => {};
    const nextRegistration = () => new Promise<void>((resolve) => (onRegister = resolve));
    const stop = startForkPushRegistration(HOST, (input) => {
      registered.push({ token: input.token, userId: input.userId });
      onRegister();
      return Promise.resolve({ ok: true });
    });
    await settled("registered");
    expect(registered).toEqual([{ token: "token-1", userId: "t3-fork:env-host" }]);
    expect(mocks.native.configure).toHaveBeenLastCalledWith(
      "device-1",
      "t3-fork:env-host",
      "t3code",
      true,
    );

    // Upstream's T3 Connect registration must not overwrite the push host's identity.
    expect(forkOwnsAndroidAgentNotifications()).toBe(true);
    configureAndroidAgentNotifications("device-1", "clerk-user", true);
    expect(mocks.native.configure).toHaveBeenCalledTimes(1);

    const rotated = nextRegistration();
    mocks.tokenListeners[0]!({ type: "android", data: "token-2" });
    await rotated;
    await settled("registered");
    expect(registered.at(-1)).toEqual({ token: "token-2", userId: "t3-fork:env-host" });

    await stopForkPush((deviceId) => {
      unregistered.push(deviceId);
      return Promise.resolve();
    });
    expect(unregistered).toEqual(["device-1"]);
    expect(mocks.native.clear).toHaveBeenCalledTimes(1);
    expect(forkOwnsAndroidAgentNotifications()).toBe(false);

    await resumeForkPush();
    expect(getForkPushRegistrationState().kind).toBe("registered");
    expect(registered).toHaveLength(3);
    stop();
  });
});
