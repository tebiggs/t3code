import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface AgentNotificationsModule {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AgentNotificationsModule>("T3AgentNotifications")
    : null;

let owned = false;

/**
 * While the push host owns the native handler, upstream's T3 Connect registration must not
 * reconfigure or clear it: a different user ID makes the handler drop every push-host message.
 */
export function forkOwnsAndroidAgentNotifications(): boolean {
  return owned;
}

export function supportsForkPush(): boolean {
  return typeof native?.configure === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function claimAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  owned = true;
  native?.configure(deviceId, userId, appScheme(), ongoingEnabled);
}

export function releaseAndroidAgentNotifications(): void {
  owned = false;
  native?.clear();
}
