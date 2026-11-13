import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { FORK_PUSH_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../connection/runtime";

const status = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-push:status",
  tag: FORK_PUSH_WS_METHODS.getStatus,
  // A sender re-checks its links every two minutes, so a fresher read shows nothing new.
  staleTimeMs: 30_000,
});

export const forkPushEnvironment = {
  status,
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-push:register",
    tag: FORK_PUSH_WS_METHODS.registerDevice,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
  }),
  unregister: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-push:unregister",
    tag: FORK_PUSH_WS_METHODS.unregisterDevice,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
  }),
  sendTest: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:fork-push:send-test",
    tag: FORK_PUSH_WS_METHODS.sendTest,
  }),
};
