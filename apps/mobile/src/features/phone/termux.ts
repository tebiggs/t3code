import { requireOptionalNativeModule } from "expo";
import { Linking, PermissionsAndroid, Platform, type Permission } from "react-native";

export const TERMUX_FDROID_URL = "https://f-droid.org/packages/com.termux/";
const RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND" as Permission;

export interface TermuxStatus {
  readonly installed: boolean;
  readonly versionName: string | null;
  readonly installer: string | null;
  readonly permissionGranted: boolean;
  /** Null when Termux is missing. */
  readonly batteryUnrestricted: boolean | null;
  readonly developerOptionsEnabled: boolean;
  readonly deviceName: string;
  readonly manufacturer: string;
  /** Claude Code and the T3 server run only on 64-bit ARM or x86 phones. */
  readonly supportedAbi: boolean;
  readonly appLaunchComponent: string | null;
}

export interface TermuxScriptResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** -1 (Activity.RESULT_OK) when Termux ran the command without an error of its own. */
  readonly err: number;
  readonly errmsg: string | null;
}

interface T3TermuxModule {
  getStatus(): TermuxStatus;
  runScript(arguments_: ReadonlyArray<string>, timeoutMs: number): Promise<TermuxScriptResult>;
  startScriptSession(arguments_: ReadonlyArray<string>, label: string): void;
  startScriptInBackground(arguments_: ReadonlyArray<string>): void;
  openTermux(): boolean;
  openTermuxSettings(): boolean;
  openDeveloperSettings(): boolean;
}

const native =
  Platform.OS === "android" ? requireOptionalNativeModule<T3TermuxModule>("T3Termux") : null;

export function supportsPhoneSetup(): boolean {
  return native !== null;
}

function requireNative(): T3TermuxModule {
  if (native === null) throw new Error("Phone setup is only available on Android.");
  return native;
}

export function getTermuxStatus(): TermuxStatus {
  return requireNative().getStatus();
}

export async function requestRunCommandPermission(): Promise<"granted" | "denied" | "blocked"> {
  const result = await PermissionsAndroid.request(RUN_COMMAND_PERMISSION);
  if (result === PermissionsAndroid.RESULTS.GRANTED) return "granted";
  return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? "blocked" : "denied";
}

/** Termux's own failures (not the command's) come back in errmsg with err != -1. */
export function termuxErrorMessage(result: TermuxScriptResult): string | null {
  if (result.err === -1) return null;
  return result.errmsg?.trim() || "Termux couldn't run the command.";
}

export function runPhoneScript(
  arguments_: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<TermuxScriptResult> {
  return requireNative().runScript(arguments_, timeoutMs);
}

/** Opens Termux on a new session running the subcommand, for anything the user watches or answers. */
export function startPhoneScriptSession(arguments_: ReadonlyArray<string>, label: string): void {
  requireNative().startScriptSession(arguments_, label);
}

/** Starts a long-running subcommand inside Termux with no terminal; Termux stays behind. */
export function startPhoneScriptInBackground(arguments_: ReadonlyArray<string>): void {
  requireNative().startScriptInBackground(arguments_);
}

export async function stopPhoneServer(): Promise<void> {
  const result = await runPhoneScript(["stop"], 60_000);
  const refused = termuxErrorMessage(result);
  if (refused !== null) throw new Error(refused);
  if (result.exitCode !== 0) {
    throw new Error(result.stdout.trim() || result.stderr.trim() || "The server didn't stop.");
  }
}

export function openTermux(): boolean {
  return requireNative().openTermux();
}

export function openTermuxSettings(): boolean {
  return requireNative().openTermuxSettings();
}

export function openDeveloperSettings(): boolean {
  return requireNative().openDeveloperSettings();
}

export function openTermuxDownload(): Promise<void> {
  return Linking.openURL(TERMUX_FDROID_URL);
}
