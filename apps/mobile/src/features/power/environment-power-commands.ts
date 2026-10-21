import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { getInitialServerConfig, request, subscribe } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../../connection/runtime";
import {
  lastOutputLine,
  RELAY_COMMAND_ENV_KEY,
  RELAY_COMMAND_TIMEOUT_MS,
  RELAY_SHELL_INPUT,
} from "./environment-power";

export class RelayCommandError extends Schema.TaggedError<RelayCommandError>()(
  "RelayCommandError",
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

/** Runs one shell command in a throwaway terminal on the connected environment. */
const runInTerminal = Effect.fn("EnvironmentPower.runInTerminal")(function* (command: string) {
  const config = yield* getInitialServerConfig();
  const target = {
    threadId: POWER_TERMINAL_THREAD_ID,
    terminalId: `power-${Date.now().toString(36)}`,
  };
  let output = "";
  let written = false;
  const last = yield* subscribe(WS_METHODS.terminalAttach, {
    ...target,
    cwd: config.cwd,
    cols: 120,
    rows: 24,
    env: { [RELAY_COMMAND_ENV_KEY]: command },
  }).pipe(
    Stream.tap((event) => {
      if (event.type === "output") {
        output = (output + event.data).slice(-OUTPUT_TAIL_LENGTH);
      }
      if (event.type !== "snapshot" || written) return Effect.void;
      written = true;
      return request(WS_METHODS.terminalWrite, { ...target, data: RELAY_SHELL_INPUT });
    }),
    Stream.takeUntil(
      (event) => event.type === "exited" || event.type === "closed" || event.type === "error",
    ),
    Stream.runLast,
    Effect.timeout(RELAY_COMMAND_TIMEOUT_MS),
    Effect.ensuring(
      request(WS_METHODS.terminalClose, { ...target, deleteHistory: true }).pipe(Effect.ignore),
    ),
  );
  const event = Option.getOrNull(last);
  if (event?.type === "exited" && event.exitCode === 0) return;
  const detail =
    event?.type === "error"
      ? event.message
      : (lastOutputLine(output) ??
        (event?.type === "exited" ? `Exited with code ${event.exitCode}.` : null));
  return yield* new RelayCommandError({ message: detail ?? "The command did not finish." });
});

export const runRelayCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-power:run-relay-command",
  execute: (input: { readonly relayEnvironmentId: EnvironmentId; readonly command: string }) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) =>
        registry.run(input.relayEnvironmentId, runInTerminal(input.command)),
      ),
      Effect.mapError((cause) =>
        cause instanceof RelayCommandError
          ? cause
          : new RelayCommandError({ message: failureMessage(cause) }),
      ),
    ),
});

/**
 * Pauses or resumes one environment's reconnect loop without switching the environment off,
 * so its threads stay listed while the machine sleeps.
 */
export const setEnvironmentConnectionDesired = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-power:set-connection-desired",
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
