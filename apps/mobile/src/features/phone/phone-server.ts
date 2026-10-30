import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
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
  usePhoneSharingRecord,
} from "../../state/phone-server-settings";
import { useWorkspaceEnvironments, workspaceConnections } from "../../state/workspace";
import { deviceRuntime, deviceServer } from "../device-runtime/device-runtime";
import { reconcilePhoneSharing } from "./phone-sharing-commands";
import { phoneServerPort } from "./phone-setup";

// The first start migrates a fresh database inside proot, which is slow on a phone.
const SERVER_START_TIMEOUT_MS = 90_000;
const SERVER_POLL_INTERVAL_MS = 1_000;
// React Native's Android client has no read timeout, so a listener that never answers would
// hold a probe forever.
const SERVER_PROBE_TIMEOUT_MS = 3_000;
const AUTO_START_INTERVAL_MS = 60_000;

/** Environments served from this phone's loopback, including ones left from Termux setup. */
function phoneEnvironments() {
  return appAtomRegistry
    .get(workspaceConnections.environmentsAtom)
    .filter((environment) => phoneServerPort(environment.displayUrl) !== null);
}

/** The phone's other servers' environments, which connecting a server on `port` replaces. */
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

/** Forgets every phone environment but `keep`, such as one from before a reinstall. */
async function retireOtherPhoneEnvironments(keep: EnvironmentId) {
  for (const environment of phoneEnvironments()) {
    if (environment.environmentId !== keep) await removeEnvironment(environment.environmentId);
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
// While an update restarts the server, another start would race it.
let updating = false;

/** Stops the server once any start in flight has settled, so it can't come up afterwards. */
export async function stopPhoneServerWhenSettled(): Promise<void> {
  await pendingStart?.catch(() => undefined);
  await deviceServer.stop();
}

/**
 * Starts the server in the background unless it already answers, and resolves with its
 * environment id. Callers share one start in flight, so Connect, the Home chip and
 * auto-start never launch two servers. `stillWanted` is checked just before launching.
 */
export function startPhoneServer(
  port: number,
  stillWanted: () => boolean = () => true,
): Promise<EnvironmentId> {
  pendingStart ??= launchPhoneServer(port, stillWanted).finally(() => {
    pendingStart = null;
  });
  return pendingStart;
}

async function launchPhoneServer(port: number, stillWanted: () => boolean): Promise<EnvironmentId> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  const running = await readPhoneServerEnvironmentId(port);
  if (running !== null) return running;
  if (!stillWanted()) throw new Error("Starting T3 Code was cancelled.");
  deviceServer.launch(port);
  const started = await waitForServer(port, deadline);
  if (started === null) {
    const log = deviceServer.logTail();
    throw new Error(
      log.length > 0
        ? `T3 Code didn't start on port ${port}:\n${log}`
        : `T3 Code didn't start on port ${port}. Its log is under Show log in phone setup.`,
    );
  }
  return started;
}

/**
 * Starts the server if needed, mints a pairing token inside Ubuntu and adds (or re-pairs)
 * this phone as an environment. Pairing only succeeds against the server that answered on
 * the port, so another listener there can't be added by mistake.
 */
export async function connectPhoneServer(port: number): Promise<EnvironmentId> {
  if (updating) throw new Error("T3 Code is restarting after an update. Try again in a moment.");
  const environmentId = await startPhoneServer(port);
  const pairingUrl = await deviceServer.pairingUrl();
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
    host: "device",
  });
  await retireOtherPhoneEnvironments(environmentId);
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
    const started = await startPhoneServer(settings.port, stillWanted);
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
      error: errorMessage(error, "T3 Code couldn't start on this phone."),
    });
    return false;
  }
}

function reconnect(environmentId: EnvironmentId) {
  void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId, {
    reportFailure: false,
  });
}

/** Installs the newest server build and Claude Code, then restarts the server on them. */
export async function updatePhoneServer(settings: PhoneServerSettings): Promise<void> {
  if (updating) return;
  updating = true;
  try {
    await deviceServer.update();
    await stopPhoneServerWhenSettled();
    const started = await startPhoneServer(settings.port);
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
  const unavailable = deviceServer.unavailable();
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the phone's server when its connection drops
  useEffect(() => {
    if (deviceRuntime !== null && down) void autoStartPhoneServer();
  }, [down]);
  const connected = phone?.connectionState === "connected";
  const sharingUnfinished = (usePhoneSharingRecord()?.phase ?? "on") !== "on";
  const relayAccount = useAtomValue(managedRelaySessionAtom)?.accountId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finishes stopping or deregistering once the server or the account comes back
  useEffect(() => {
    if (deviceRuntime !== null && sharingUnfinished && (connected || relayAccount !== null)) {
      void reconcilePhoneSharing();
    }
  }, [connected, sharingUnfinished, relayAccount]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the app returning to the foreground
  useEffect(() => {
    if (deviceRuntime === null) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void autoStartPhoneServer();
        void reconcilePhoneSharing();
      }
    });
    return () => subscription.remove();
  }, []);
}
