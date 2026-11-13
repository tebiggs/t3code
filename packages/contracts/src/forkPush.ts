import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * This fork's push host: one of the owner's servers holds an FCM key and sends Android
 * notifications for itself and the environments linked to it.
 */
export const FORK_PUSH_WS_METHODS = {
  getStatus: "forkPush.getStatus",
  registerDevice: "forkPush.registerDevice",
  unregisterDevice: "forkPush.unregisterDevice",
  sendTest: "forkPush.sendTest",
} as const;

/** The same fields as relay.ts's RelayAgentAwarenessPreferences, which stays out of client bundles. */
const ForkPushPreferences = Schema.Struct({
  liveActivitiesEnabled: Schema.Boolean,
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});

export const ForkPushDeviceRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  /** Echoed in every message; the phone's native handler drops messages for another identity. */
  userId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  packageName: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.String,
  preferences: ForkPushPreferences,
});
export type ForkPushDeviceRegistration = typeof ForkPushDeviceRegistration.Type;

export const ForkPushStatus = Schema.Struct({
  /** `host` holds the key; `sender` sends to a linked push host; `none` publishes as upstream does. */
  role: Schema.Literals(["host", "sender", "none"]),
  /** The push host this server sends to, or last sent to. */
  host: Schema.NullOr(
    Schema.Struct({
      environmentId: Schema.String,
      label: Schema.String,
      url: Schema.String,
      linkExpiresAt: Schema.String,
    }),
  ),
  checkedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /** Upstream's "Publish agent activity" is explicitly off here, which the push host respects. */
  publishingOff: Schema.Boolean,
  devices: Schema.Array(
    Schema.Struct({
      deviceId: Schema.String,
      label: Schema.String,
      registeredAt: Schema.String,
      lastSentAt: Schema.NullOr(Schema.String),
      lastError: Schema.NullOr(Schema.String),
    }),
  ),
  peers: Schema.Array(Schema.Struct({ environmentId: Schema.String, lastHeardAt: Schema.String })),
});
export type ForkPushStatus = typeof ForkPushStatus.Type;

export class ForkPushError extends Schema.TaggedError<ForkPushError>()("ForkPushError", {
  message: Schema.String,
}) {}

const ForkPushGetStatusRpc = Rpc.make(FORK_PUSH_WS_METHODS.getStatus, {
  payload: Schema.Struct({}),
  success: ForkPushStatus,
  error: EnvironmentAuthorizationError,
});

const ForkPushRegisterDeviceRpc = Rpc.make(FORK_PUSH_WS_METHODS.registerDevice, {
  payload: ForkPushDeviceRegistration,
  success: Schema.Struct({}),
  error: Schema.Union([ForkPushError, EnvironmentAuthorizationError]),
});

const ForkPushUnregisterDeviceRpc = Rpc.make(FORK_PUSH_WS_METHODS.unregisterDevice, {
  payload: Schema.Struct({ deviceId: TrimmedNonEmptyString }),
  success: Schema.Struct({ removed: Schema.Boolean }),
  error: Schema.Union([ForkPushError, EnvironmentAuthorizationError]),
});

const ForkPushSendTestRpc = Rpc.make(FORK_PUSH_WS_METHODS.sendTest, {
  payload: Schema.Struct({ deviceId: TrimmedNonEmptyString }),
  success: Schema.Struct({}),
  error: Schema.Union([ForkPushError, EnvironmentAuthorizationError]),
});

export const FORK_PUSH_RPCS = [
  ForkPushGetStatusRpc,
  ForkPushRegisterDeviceRpc,
  ForkPushUnregisterDeviceRpc,
  ForkPushSendTestRpc,
] as const;

/** Reading status is a query, which clients may not guard; the server still requires this. */
export const FORK_PUSH_QUERY_SCOPES = {
  [FORK_PUSH_WS_METHODS.getStatus]: AuthOrchestrationReadScope,
} as const;

export const FORK_PUSH_RPC_SCOPES = {
  [FORK_PUSH_WS_METHODS.sendTest]: AuthOrchestrationReadScope,
  [FORK_PUSH_WS_METHODS.registerDevice]: AuthSettingsWriteScope,
  [FORK_PUSH_WS_METHODS.unregisterDevice]: AuthSettingsWriteScope,
} as const;
