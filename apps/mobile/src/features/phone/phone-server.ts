import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairingUrl } from "../../connection/onboarding";
import type { PhoneServerSettings } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  phoneServerSettingsAtom,
  setPhoneServerSettings,
  usePhoneServerSettings,
} from "../../state/phone-server-settings";
import { useWorkspaceEnvironments, workspaceConnections } from "../../state/workspace";
import { DEVICE_SERVER_PORT, deviceServerHost } from "../device-runtime/device-runtime";
import type { PhoneServerHostKind } from "../../persistence/mobile-preferences";
import { termuxHost, type PhoneServerHost } from "./phone-server-host";
import { parsePhoneScriptStatus, phoneServerPort, type PhoneProbe } from "./phone-setup";
import { runPhoneScript, supportsPhoneSetup, termuxErrorMessage } from "./termux";

const STATUS_TIMEOUT_MS = 60_000;
// The first start migrates a fresh database inside proot, which is slow on a phone.
const SERVER_START_TIMEOUT_MS = 90_000;
const SERVER_POLL_INTERVAL_MS = 1_000;
// React Native's Android client has no read timeout, so a listener that never answers would
// hold a probe forever.
const SERVER_PROBE_TIMEOUT_MS = 3_000;
const AUTO_START_INTERVAL_MS = 60_000;

export function phoneServerHost(kind: PhoneServerHostKind | undefined): PhoneServerHost {
  return kind === "device" ? deviceServerHost : termuxHost;
}

/** Environments served from this phone, whichever host runs them. */
function phoneEnvironments() {
  return appAtomRegistry
    .get(workspaceConnections.environmentsAtom)
    .filter((environment) => phoneServerPort(environment.displayUrl) !== null);
}

/**
 * The phone's other servers, which connecting a server on `port` replaces: this phone runs
 * one at a time, so switching between Termux and the app's runtime doesn't leave two.
 */
export function replacedPhoneEnvironments(port: number) {
  return phoneEnvironments().filter(
    (environment) => phoneServerPort(environment.displayUrl) !== port,
  );
}

function removeEnvironment(environmentId: EnvironmentId) {
  return runAtomCommand(appAtomRegistry, environmentCatalog.remove, environmentId, {
    reportFailure: false,
  });
}

/** Stops the phone's other servers and forgets every phone environment but `keep`. */
async function retireOtherPhoneEnvironments(keep: EnvironmentId, port: number) {
  for (const environment of phoneEnvironments()) {
    if (environment.environmentId === keep) continue;
    const environmentPort = phoneServerPort(environment.displayUrl);
    // An entry on the same port is a server this one replaced, such as before a reinstall.
    if (environmentPort !== port) {
      const host = environmentPort === DEVICE_SERVER_PORT ? deviceServerHost : termuxHost;
      await host.stop().catch(() => undefined);
    }
    await removeEnvironment(environment.environmentId);
  }
}

/** Forgets the environments of the phone's server on `port`, once that server is gone. */
export async function forgetPhoneEnvironments(port: number): Promise<void> {
  for (const environment of phoneEnvironments()) {
    if (phoneServerPort(environment.displayUrl) === port) {
      await removeEnvironment(environment.environmentId);
    }
  }
}

/** Starting the server from the home chip, the detail page or on app open. */
export interface PhoneServerRuntime {
  readonly starting: boolean;
  /** Why the last start failed; cleared by the next attempt. */
  readonly error: string | null;
}

const IDLE_RUNTIME: PhoneServerRuntime = { starting: false, error: null };

export const phoneServerRuntimeAtom = Atom.make<PhoneServerRuntime>(IDLE_RUNTIME).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:phone-server:runtime"),
);

export function usePhoneServerRuntime(): PhoneServerRuntime {
  return useAtomValue(phoneServerRuntimeAtom);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_TERMUX_TIMEOUT"
  );
}

/** Runs `t3-phone status` in Termux. Never throws. */
export async function probePhone(): Promise<PhoneProbe> {
  try {
    const result = await runPhoneScript(["status"], STATUS_TIMEOUT_MS);
    const refused = termuxErrorMessage(result);
    if (refused !== null) return { kind: "refused", message: refused };
    if (result.exitCode !== 0) {
      return {
        kind: "failed",
        message: result.stderr.trim() || `The status check exited with ${result.exitCode}.`,
      };
    }
    return { kind: "ok", status: parsePhoneScriptStatus(result.stdout) };
  } catch (error) {
    if (isTimeout(error)) return { kind: "timeout" };
    return { kind: "failed", message: errorMessage(error, "Termux couldn't run the check.") };
  }
}

/** The environment a T3 server on this port reports, or null when nothing answers. */
export async function readPhoneServerEnvironmentId(port: number): Promise<EnvironmentId | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("environmentId" in body)) return null;
    return typeof body.environmentId === "string" ? EnvironmentId.make(body.environmentId) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer(port: number, deadline: number): Promise<EnvironmentId | null> {
  while (Date.now() < deadline) {
    const environmentId = await readPhoneServerEnvironmentId(port);
    if (environmentId !== null) return environmentId;
    await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }
  return null;
}

let pendingStart: Promise<EnvironmentId> | null = null;
// While an update restarts the server, any other start would race it for serve.lock.
let updating = false;

/**
 * Stops the server once any start in flight has settled: a start already handed to Termux
 * takes its lock only later, so stopping first would miss it and let it come up afterwards.
 */
export async function stopPhoneServerWhenSettled(
  host: PhoneServerHost = phoneServerHost(appAtomRegistry.get(phoneServerSettingsAtom)?.host),
): Promise<void> {
  await pendingStart?.catch(() => undefined);
  await host.stop();
}

/**
 * Starts the server in the background unless it already answers, and resolves with its
 * environment id. Callers share one start in flight, so Connect, the Home chip and
 * auto-start never launch two servers. `stillWanted` is checked just before launching.
 */
export function startPhoneServer(
  host: PhoneServerHost,
  port: number,
  stillWanted: () => boolean = () => true,
): Promise<EnvironmentId> {
  pendingStart ??= launchPhoneServer(host, port, stillWanted).finally(() => {
    pendingStart = null;
  });
  return pendingStart;
}

async function launchPhoneServer(
  host: PhoneServerHost,
  port: number,
  stillWanted: () => boolean,
): Promise<EnvironmentId> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  const running = await readPhoneServerEnvironmentId(port);
  if (running !== null) return running;
  if (!stillWanted()) throw new Error("Starting T3 Code was cancelled.");
  host.launch(port);
  const started = await waitForServer(port, deadline);
  if (started === null) {
    const log = await host.logTail();
    throw new Error(
      log.length > 0
        ? `T3 Code didn't start on port ${port}:\n${log}`
        : `T3 Code didn't start on port ${port}. Its log is ${host.logLocation}.`,
    );
  }
  return started;
}

/**
 * Starts the server if needed, mints a pairing token inside Ubuntu and adds (or re-pairs)
 * this phone as an environment. Pairing only succeeds against the server that answered on
 * the port, so another listener there can't be added by mistake.
 */
export async function connectPhoneServer(
  host: PhoneServerHost,
  port: number,
): Promise<EnvironmentId> {
  if (updating) throw new Error("T3 Code is restarting after an update. Try again in a moment.");
  const environmentId = await startPhoneServer(host, port);
  const pairingUrl = await host.pairingUrl();
  const connected = await runAtomCommand(
    appAtomRegistry,
    connectPairingUrl,
    { pairingUrl, expectedEnvironmentId: environmentId },
    { reportFailure: false },
  );
  if (AsyncResult.isFailure(connected)) throw squashAtomCommandFailure(connected);
  const previous = appAtomRegistry.get(phoneServerSettingsAtom);
  setPhoneServerSettings({
    environmentId,
    port,
    autoStart: previous?.autoStart ?? true,
    host: host.kind,
  });
  await retireOtherPhoneEnvironments(environmentId, port);
  return environmentId;
}

let lastAutoStartAt = 0;

/** Starts the phone server and reconnects to it, reporting progress in phoneServerRuntimeAtom. */
export async function startAndReconnectPhoneServer(
  settings: PhoneServerSettings,
  stillWanted?: () => boolean,
): Promise<boolean> {
  if (updating || appAtomRegistry.get(phoneServerRuntimeAtom).starting) return false;
  appAtomRegistry.set(phoneServerRuntimeAtom, { starting: true, error: null });
  try {
    const started = await startPhoneServer(
      phoneServerHost(settings.host),
      settings.port,
      stillWanted,
    );
    if (started !== settings.environmentId) {
      throw new Error(
        "A different T3 Code server is answering on this phone. Open phone setup to connect it.",
      );
    }
    reconnect(settings.environmentId);
    appAtomRegistry.set(phoneServerRuntimeAtom, IDLE_RUNTIME);
    return true;
  } catch (error) {
    appAtomRegistry.set(phoneServerRuntimeAtom, {
      starting: false,
      error: errorMessage(error, `T3 Code couldn't start ${phoneServerHost(settings.host).where}.`),
    });
    return false;
  }
}

function reconnect(environmentId: EnvironmentId) {
  void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId, {
    reportFailure: false,
  });
}

/** Installs the newest server build in Ubuntu, then restarts the server on it. */
export async function updatePhoneServer(settings: PhoneServerSettings): Promise<void> {
  if (updating) return;
  updating = true;
  const host = phoneServerHost(settings.host);
  try {
    await host.update();
    await stopPhoneServerWhenSettled(host);
    const started = await startPhoneServer(host, settings.port);
    if (started !== settings.environmentId) {
      throw new Error("A different T3 Code server is answering on this phone.");
    }
    reconnect(settings.environmentId);
  } finally {
    updating = false;
  }
}

async function autoStartPhoneServer() {
  // Starting the server from the background would fail or surprise; the next foreground retries.
  if (AppState.currentState !== "active" || updating) return;
  const settings = appAtomRegistry.get(phoneServerSettingsAtom);
  if (settings === null || !settings.autoStart) return;
  const environment = appAtomRegistry
    .get(workspaceConnections.environmentsAtom)
    .find((candidate) => candidate.environmentId === settings.environmentId);
  if (!environment?.isEnabled || environment.connectionState === "connected") return;
  if (Date.now() - lastAutoStartAt < AUTO_START_INTERVAL_MS) return;
  lastAutoStartAt = Date.now();
  const unavailable = phoneServerHost(settings.host).unavailable();
  if (unavailable !== null) {
    appAtomRegistry.set(phoneServerRuntimeAtom, { starting: false, error: unavailable });
    return;
  }
  // Stop or Remove may switch auto-start off while this one is still probing the port.
  await startAndReconnectPhoneServer(
    settings,
    () => !updating && appAtomRegistry.get(phoneServerSettingsAtom)?.autoStart === true,
  );
}

/**
 * Starts the phone server, at most once a minute, when its environment can't connect: on
 * launch once connections hydrate, after a drop, and whenever the app comes back.
 */
export function usePhoneServerWorker() {
  const settings = usePhoneServerSettings();
  const phone = useWorkspaceEnvironments().find(
    (environment) => environment.environmentId === settings?.environmentId,
  );
  const down =
    phone !== undefined &&
    phone.connectionState !== "connected" &&
    phone.connectionState !== "connecting";
  // oxlint-disable-next-line t3code/react-effect-budget -- starts the phone's server when its connection drops
  useEffect(() => {
    if (supportsPhoneSetup() && down) void autoStartPhoneServer();
  }, [down]);
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the app returning to the foreground
  useEffect(() => {
    if (!supportsPhoneSetup()) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void autoStartPhoneServer();
    });
    return () => subscription.remove();
  }, []);
}
