import { requireOptionalNativeModule, type NativeModule } from "expo";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

import type { PhoneServerHost } from "../phone/phone-server-host";

/** Away from Termux's 3773, so both servers can run while someone moves between them. */
export const DEVICE_SERVER_PORT = 3774;

export interface DeviceRuntimeJob {
  readonly kind: "install" | "update";
  readonly running: boolean;
  readonly step: string | null;
  readonly stepTitle: string | null;
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly error: string | null;
}

export type DeviceRuntimeLogin =
  | { readonly state: "starting" }
  /** The browser is open; manualUrl ends on a code to paste, if the browser can't return. */
  | { readonly state: "browser"; readonly manualUrl: string | null }
  | { readonly state: "done" }
  | { readonly state: "cancelled" }
  | { readonly state: "failed"; readonly message: string };

export interface DeviceRuntimeStatus {
  /** A 64-bit ARM phone, or an x86_64 emulator, with proot in the APK. */
  readonly supported: boolean;
  /** Phone setup uses this runtime instead of Termux. */
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly serverRunning: boolean;
  readonly job: DeviceRuntimeJob | null;
  readonly login: DeviceRuntimeLogin | null;
}

/** What is installed in the runtime's Ubuntu. */
export interface DeviceRuntimeInspection {
  readonly nodeVersion: string | null;
  readonly claudeVersion: string | null;
  readonly claudeSignedIn: boolean;
  readonly claudePlan: string | null;
  readonly t3Version: string | null;
}

type DeviceRuntimeEvents = {
  onJob(job: DeviceRuntimeJob): void;
  onLogin(login: DeviceRuntimeLogin): void;
};

declare class T3DeviceRuntimeModule extends NativeModule<DeviceRuntimeEvents> {
  getStatus(): DeviceRuntimeStatus;
  setEnabled(enabled: boolean): void;
  install(deviceName: string): Promise<void>;
  update(): Promise<void>;
  cancelJob(): void;
  getJobLog(): ReadonlyArray<string>;
  inspect(): Promise<Readonly<Record<string, string>>>;
  startServer(port: number): void;
  stopServer(): Promise<void>;
  serverLog(lines: number): string;
  pair(): Promise<string>;
  startLogin(): void;
  submitLoginCode(code: string): void;
  cancelLogin(): void;
  logout(): Promise<number>;
  remove(): Promise<void>;
}

export const deviceRuntime =
  Platform.OS === "android"
    ? requireOptionalNativeModule<T3DeviceRuntimeModule>("T3DeviceRuntime")
    : null;

export function supportsDeviceRuntime(): boolean {
  return deviceRuntime?.getStatus().supported === true;
}

export function requireDeviceRuntime(): T3DeviceRuntimeModule {
  if (deviceRuntime === null) throw new Error("The on-device runtime needs the Android app.");
  return deviceRuntime;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

export function parseDeviceInspection(
  values: Readonly<Record<string, string>>,
): DeviceRuntimeInspection {
  return {
    nodeVersion: nonEmpty(values.node_version),
    claudeVersion: nonEmpty(values.claude_version),
    claudeSignedIn: values.claude_signed_in === "true",
    claudePlan: nonEmpty(values.claude_plan),
    t3Version: nonEmpty(values.t3_version),
  };
}

export async function inspectDeviceRuntime(): Promise<DeviceRuntimeInspection> {
  return parseDeviceInspection(await requireDeviceRuntime().inspect());
}

/** The runtime's state, kept current by its job and sign-in events. */
export function useDeviceRuntimeStatus() {
  const native = requireDeviceRuntime();
  const [status, setStatus] = useState<DeviceRuntimeStatus>(() => native.getStatus());
  const refresh = useCallback(() => setStatus(native.getStatus()), [native]);
  // oxlint-disable-next-line t3code/react-effect-budget -- follows the native installer and sign-in
  useEffect(() => {
    const job = native.addListener("onJob", () => setStatus(native.getStatus()));
    const login = native.addListener("onLogin", () => setStatus(native.getStatus()));
    return () => {
      job.remove();
      login.remove();
    };
  }, [native]);
  return { status, refresh };
}

export const deviceServerHost: PhoneServerHost = {
  kind: "device",
  where: "on this phone",
  logLocation: "the server log in phone setup",
  unavailable() {
    const status = deviceRuntime?.getStatus();
    if (!status?.installed) return "T3 Code isn't installed on this phone anymore.";
    if (status.job?.running) return "Setup or an update is still running.";
    return null;
  },
  launch(port) {
    requireDeviceRuntime().startServer(port);
  },
  stop: () => requireDeviceRuntime().stopServer(),
  pairingUrl: () => requireDeviceRuntime().pair(),
  update: () => requireDeviceRuntime().update(),
  logTail: async () => requireDeviceRuntime().serverLog(15),
};
