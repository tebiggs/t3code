import type { EnvironmentId, ForkPushDeviceRegistration } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { loadOrCreateAgentAwarenessDeviceId, loadPreferences } from "../../persistence/imperative";
import {
  claimAndroidAgentNotifications,
  releaseAndroidAgentNotifications,
} from "./nativeOwnership";

export type ForkPushRegistrationState =
  | { readonly kind: "idle" }
  | { readonly kind: "needs-permission"; readonly hostEnvironmentId: EnvironmentId }
  | { readonly kind: "registering"; readonly hostEnvironmentId: EnvironmentId }
  | {
      readonly kind: "registered";
      readonly hostEnvironmentId: EnvironmentId;
      readonly deviceId: string;
    }
  | { readonly kind: "stopped"; readonly hostEnvironmentId: EnvironmentId }
  | { readonly kind: "failed"; readonly hostEnvironmentId: EnvironmentId; readonly error: string };

type Register = (
  input: ForkPushDeviceRegistration,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;

const STORAGE_KEY = "t3code.fork-push.v1";
/** A registration this old is sent again on foreground, in case the host lost it. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

let state: ForkPushRegistrationState = { kind: "idle" };
const listeners = new Set<() => void>();
let active: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly run: () => Promise<void>;
} | null = null;

function setState(next: ForkPushRegistrationState) {
  state = next;
  for (const listener of listeners) listener();
}

export const getForkPushRegistrationState = () => state;
export function subscribeForkPushRegistrationState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function loadStopped(): Promise<boolean> {
  try {
    await whenProtectedDataAvailable();
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "stopped" in parsed
      ? parsed.stopped === true
      : false;
  } catch {
    return false;
  }
}

async function saveStopped(stopped: boolean): Promise<void> {
  await whenProtectedDataAvailable();
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify({ stopped }));
}

/** The native handler drops messages for another user, so the identity names the push host. */
const forkPushUserId = (hostEnvironmentId: string) => `t3-fork:${hostEnvironmentId}`;

/**
 * Registers this phone with the push host now, when the app comes back, and when FCM rotates
 * its token. Returns the cleanup. Only one push host is registered with at a time.
 */
export function startForkPushRegistration(
  hostEnvironmentId: EnvironmentId,
  register: Register,
): () => void {
  if (active !== null) return () => {};
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let registered: { readonly key: string; readonly at: number } | null = null;

  const attempt = async (observedToken: string | null) => {
    if (await loadStopped()) {
      registered = null;
      setState({ kind: "stopped", hostEnvironmentId });
      return;
    }
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      setState({ kind: "needs-permission", hostEnvironmentId });
      return;
    }
    const token =
      observedToken ?? String((await Notifications.getDevicePushTokenAsync()).data ?? "");
    if (token.trim() === "") {
      setState({ kind: "failed", hostEnvironmentId, error: "This phone has no FCM token yet." });
      return;
    }
    const deviceId = await loadOrCreateAgentAwarenessDeviceId();
    const preferences = await loadPreferences().catch(() => null);
    const ongoing = preferences?.liveActivitiesEnabled !== false;
    const userId = forkPushUserId(hostEnvironmentId);
    const key = JSON.stringify([token, deviceId, ongoing]);
    if (registered?.key === key && Date.now() - registered.at < REFRESH_AFTER_MS) return;
    claimAndroidAgentNotifications(deviceId, userId, ongoing);
    setState({ kind: "registering", hostEnvironmentId });
    const result = await register({
      deviceId,
      userId,
      token,
      packageName: Constants.expoConfig?.android?.package?.trim() || null,
      label: Constants.deviceName?.trim() || "Android device",
      preferences: {
        notificationsEnabled: true,
        liveActivitiesEnabled: ongoing,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    if (disposed) return;
    if (result.ok) {
      registered = { key, at: Date.now() };
      setState({ kind: "registered", hostEnvironmentId, deviceId });
    } else {
      setState({ kind: "failed", hostEnvironmentId, error: result.error });
    }
  };

  // A rotation that lands mid-registration runs once the current one ends, with the new token.
  let rerun: { readonly token: string | null } | null = null;
  const run = (observedToken: string | null = null): Promise<void> => {
    if (inFlight !== null) {
      rerun = { token: observedToken ?? rerun?.token ?? null };
      return inFlight;
    }
    inFlight = attempt(observedToken)
      .catch((error: unknown) => {
        if (!disposed) setState({ kind: "failed", hostEnvironmentId, error: String(error) });
      })
      .finally(() => {
        inFlight = null;
        const next = rerun;
        rerun = null;
        if (next !== null && !disposed) void run(next.token);
      });
    return inFlight;
  };

  const tokenSubscription = Notifications.addPushTokenListener((token) => {
    if (typeof token.data === "string" && token.data.trim() !== "") void run(token.data.trim());
  });
  const appStateSubscription = AppState.addEventListener("change", (next) => {
    if (next === "active") void run();
  });
  active = { hostEnvironmentId, run: () => run() };
  void run();

  return () => {
    disposed = true;
    tokenSubscription.remove();
    appStateSubscription.remove();
    if (active?.hostEnvironmentId === hostEnvironmentId) active = null;
  };
}

/** Registers again now, after the user turned notifications back on or granted permission. */
export async function resumeForkPush(): Promise<void> {
  await saveStopped(false);
  await active?.run();
}

/** Stops push-host notifications on this phone until the user turns them back on. */
export async function stopForkPush(unregister: (deviceId: string) => Promise<void>) {
  const hostEnvironmentId = active?.hostEnvironmentId ?? null;
  await saveStopped(true);
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  releaseAndroidAgentNotifications();
  await unregister(deviceId);
  if (hostEnvironmentId !== null) setState({ kind: "stopped", hostEnvironmentId });
}
