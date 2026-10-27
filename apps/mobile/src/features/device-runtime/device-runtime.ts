import { requireOptionalNativeModule, type NativeModule } from "expo";
import { Platform } from "react-native";

export interface DeviceRuntimeState {
  readonly running: boolean;
  readonly step?: string;
  readonly stepTitle?: string;
  readonly failure?: string | null;
  /** The finished run's report, as JSON. */
  readonly report?: string;
}

export interface DeviceRuntimeStatus extends DeviceRuntimeState {
  /** A 64-bit ARM phone, or an x86_64 emulator, with proot in the APK. */
  readonly supported: boolean;
  readonly ubuntuInstalled: boolean;
  readonly log: ReadonlyArray<string>;
}

type DeviceRuntimeEvents = {
  onLog(event: { readonly lines: ReadonlyArray<string> }): void;
  onState(state: DeviceRuntimeState): void;
};

declare class T3DeviceRuntimeModule extends NativeModule<DeviceRuntimeEvents> {
  getStatus(): DeviceRuntimeStatus;
  startPrototype(): boolean;
  cancel(): void;
  reset(): Promise<void>;
}

export const deviceRuntime =
  Platform.OS === "android"
    ? requireOptionalNativeModule<T3DeviceRuntimeModule>("T3DeviceRuntime")
    : null;
