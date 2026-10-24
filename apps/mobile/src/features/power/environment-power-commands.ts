import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { getInitialServerConfig, request, subscribeDynamic } from "@t3tools/client-runtime/rpc";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type TerminalAttachStreamEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../../connection/runtime";
import {
  lastOutputLine,
  LIVE_PROBE_TIMEOUT_MS,
  RELAY_COMMAND_ENV_KEY,
  RELAY_COMMAND_TIMEOUT_MS,
  resolvePowerCommand,
  shellInputFor,
  TERMINAL_CLOSE_TIMEOUT_MS,
  type PowerCommand,
} from "./environment-power";

export class PowerCommandError extends Schema.TaggedError<PowerCommandError>()(
  "PowerCommandError",
  { message: Schema.String },
) {}

// Terminals are keyed by thread; this id belongs to no real thread, so the
// session never shows up in a thread's terminal drawer.
const POWER_TERMINAL_THREAD_ID = "t3-mobile-power";
const OUTPUT_TAIL_LENGTH = 4_096;

function failureMessage(cause: unknown): string {
  if (Cause.isTimeoutError(cause)) return "The command didn't finish within a minute.";
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The command could not be run.";
}

/** The shell's exit, from a live event or from the snapshot a reattach returns after it ended. */
function terminalOutcome(
  event: TerminalAttachStreamEvent,
  written: boolean,
): { readonly exitCode: number | null; readonly message: string | null } | null {
  switch (event.type) {
    case "exited":
      return { exitCode: event.exitCode, message: null };
    case "error":
      return { exitCode: null, message: event.message };
    case "closed":
      return { exitCode: null, message: "The terminal closed before the command finished." };
    case "snapshot":
      return written && (event.snapshot.status === "exited" || event.snapshot.status === "error")
        ? { exitCode: event.snapshot.exitCode, message: null }
        : null;
    default:
      return null;
  }
}

/** Runs one command in a throwaway terminal on the connected environment. */
const runInTerminal = Effect.fn("EnvironmentPower.runInTerminal")(function* (
  command: PowerCommand,
) {
  const config = yield* getInitialServerConfig();
  const os = config.environment.platform.os;
  const resolved = resolvePowerCommand(command, os);
  if (resolved === null) {
    return yield* new PowerCommandError({
      message: "T3 Code can't tell which operating system this machine runs.",
    });
  }
  const target = {
    threadId: POWER_TERMINAL_THREAD_ID,
    terminalId: `power-${Date.now().toString(36)}`,
  };
  const attachInput = {
    ...target,
    cwd: config.cwd,
    cols: 120,
    rows: 24,
    env: { ...resolved.env, [RELAY_COMMAND_ENV_KEY]: resolved.command },
  };
  let output = "";
  let written = false;
  let replied = false;
  const outcome = yield* subscribeDynamic(WS_METHODS.terminalAttach, () =>
    // A resubscribe after a dropped connection must not open a second shell.
    Effect.sync(() => (replied ? { ...attachInput, resume: true } : attachInput)),
  ).pipe(
    Stream.onFirst(() =>
      Effect.sync(() => {
        replied = true;
      }),
    ),
    Stream.tap((event) => {
      if (event.type === "output") {
        output = (output + event.data).slice(-OUTPUT_TAIL_LENGTH);
      }
      if (event.type !== "snapshot" || written) return Effect.void;
      written = true;
      return request(WS_METHODS.terminalWrite, { ...target, data: shellInputFor(os) });
    }),
    Stream.map((event) => terminalOutcome(event, written)),
    Stream.takeUntil((result) => result !== null),
    Stream.runLast,
    Effect.timeout(RELAY_COMMAND_TIMEOUT_MS),
    Effect.ensuring(
      request(WS_METHODS.terminalClose, { ...target, deleteHistory: true }).pipe(
        Effect.timeout(TERMINAL_CLOSE_TIMEOUT_MS),
        Effect.ignore,
      ),
    ),
  );
  const result = Option.getOrNull(outcome);
  if (result?.exitCode === 0) return;
  const detail =
    result?.message ??
    lastOutputLine(output) ??
    (result?.exitCode != null ? `Exited with code ${result.exitCode}.` : null);
  return yield* new PowerCommandError({ message: detail ?? "The command did not finish." });
});

export const runPowerCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-power:run-command",
  execute: (input: { readonly environmentId: EnvironmentId; readonly command: PowerCommand }) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) => registry.run(input.environmentId, runInTerminal(input.command))),
      Effect.mapError((cause) =>
        cause instanceof PowerCommandError
          ? cause
          : new PowerCommandError({ message: failureMessage(cause) }),
      ),
    ),
});

/**
 * Pauses or resumes one environment's reconnect loop without switching the environment off,
 * so its threads stay listed while the machine sleeps. Serial per environment, so the last
 * request wins.
 */
export const setEnvironmentConnectionDesired = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-power:set-connection-desired",
  scheduler: createAtomCommandScheduler(),
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: { readonly environmentId: EnvironmentId; readonly desired: boolean }) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) =>
        registry.run(
          input.environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.flatMap((supervisor) =>
              input.desired ? supervisor.connect : supervisor.disconnect,
            ),
          ),
        ),
      ),
    ),
});

// A retry signal interrupts an attempt that is still connecting, so only cut a backoff wait short.
const retryIfWaiting = Effect.fn("EnvironmentPower.retryIfWaiting")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const state = yield* SubscriptionRef.get(supervisor.state);
  if (state.phase === "backoff") yield* supervisor.retryNow;
});

export const retryEnvironmentIfWaiting = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-power:retry-if-waiting",
  execute: (environmentId: EnvironmentId) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) => registry.run(environmentId, retryIfWaiting())),
    ),
});

// A machine that fell asleep keeps reading as connected until its socket times out, so the
// session has to answer a round trip before anything acts on "awake".
const probeLiveSession = Effect.fn("EnvironmentPower.probeLiveSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return false;
  return yield* session.value.probe.pipe(
    Effect.timeout(LIVE_PROBE_TIMEOUT_MS),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

/** Whether the environment answers right now. */
export const probeEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-power:probe",
  execute: (environmentId: EnvironmentId) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) => registry.run(environmentId, probeLiveSession())),
    ),
});
