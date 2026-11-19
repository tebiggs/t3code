import type { EnvironmentId, ForkPushStatus } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, useGT, useMessages } from "gt-react-native";
import { useSyncExternalStore } from "react";

import * as Dialog from "../../components/ui/Dialog";
import type { MessageResolver } from "../../i18n/messages";
import { runtime } from "../../lib/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { forkPushEnvironment } from "./forkPushState";
import { supportsForkPush } from "./nativeOwnership";
import {
  type ForkPushRegistrationState,
  getForkPushRegistrationState,
  resumeForkPush,
  stopForkPush,
  subscribeForkPushRegistrationState,
} from "./registrar";

const PUBLISHING_OFF = msg("Publish agent activity is off there, so its threads don't notify.");

function registrationText(state: ForkPushRegistrationState, resolve: MessageResolver): string {
  switch (state.kind) {
    case "idle":
    case "registering":
      return resolve(msg("Registering this phone…"));
    case "registered":
      return resolve(msg("This phone gets its notifications."));
    case "needs-permission":
      return resolve(msg("Notifications are off for T3 Code. Tap to turn them on."));
    case "stopped":
      return resolve(msg("Stopped on this phone."));
    case "failed":
      return resolve(msg("Couldn't register: {error}", { error: state.error }));
  }
}

/** Notifications through the owner's push host, the fork's replacement for T3 Connect's relay. */
export function ForkPushSettingsSection() {
  const gt = useGT();
  const registration = useSyncExternalStore(
    subscribeForkPushRegistrationState,
    getForkPushRegistrationState,
    getForkPushRegistrationState,
  );
  const environments = useWorkspaceEnvironments().filter(
    (environment) => environment.connectionState === "connected",
  );
  if (!supportsForkPush()) return null;
  const hostEnvironmentId = registration.kind === "idle" ? null : registration.hostEnvironmentId;
  const host = environments.find((environment) => environment.environmentId === hostEnvironmentId);

  return (
    <SettingsSection
      title={gt("Push host")}
      footer={gt(
        "The environment started with an FCM key sends this phone's notifications. Others reach it through a link to it in Settings → Environments → Linked environments; links last 30 days.",
      )}
    >
      {host === undefined ? (
        <SettingsRow
          icon="slash.circle"
          label={gt("No push host")}
          value={gt("None of your connected environments holds an FCM key.")}
          valuePosition="below"
        />
      ) : (
        <HostRows
          environmentId={host.environmentId}
          label={host.environmentLabel}
          registration={registration}
        />
      )}
      {environments
        .filter((environment) => environment.environmentId !== hostEnvironmentId)
        .map((environment) => (
          <SenderRow
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.environmentLabel}
            hostEnvironmentId={hostEnvironmentId}
            hostLabel={host?.environmentLabel ?? null}
          />
        ))}
    </SettingsSection>
  );
}

function HostRows(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly registration: ForkPushRegistrationState;
}) {
  const gt = useGT();
  const m = useMessages();
  const status = useEnvironmentQuery(
    forkPushEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  const sendTest = useAtomCommand(forkPushEnvironment.sendTest, "send a test notification");
  const unregister = useAtomCommand(forkPushEnvironment.unregister, "stop notifications");
  const canRegister = useAtomValue(
    forkPushEnvironment.register.permissionAtom(props.environmentId),
  );
  const { registration } = props;
  const publishingOff = status.data?.publishingOff === true;

  const turnOn = async () => {
    if (registration.kind === "needs-permission") {
      const permission = await runtime
        .runPromise(requestAgentNotificationPermission)
        .catch(() => null);
      if (permission?.type !== "granted") {
        Dialog.alert(
          gt("Notifications are off"),
          gt("Allow notifications for T3 Code in Android Settings, then come back here."),
        );
        return;
      }
    }
    await resumeForkPush();
  };

  const stop = () =>
    stopForkPush(async (deviceId) => {
      await unregister({ environmentId: props.environmentId, input: { deviceId } });
    });

  return (
    <>
      <SettingsRow
        icon="bell.badge"
        label={props.label}
        value={
          publishingOff
            ? `${registrationText(registration, m)} ${m(PUBLISHING_OFF)}`
            : registrationText(registration, m)
        }
        valuePosition="below"
        {...(registration.kind === "needs-permission" || registration.kind === "failed"
          ? { onPress: () => void turnOn() }
          : {})}
      />
      {registration.kind === "registered" ? (
        <SettingsRow
          icon="bolt.circle"
          label={gt("Send a test notification")}
          onPress={() =>
            void sendTest({
              environmentId: props.environmentId,
              input: { deviceId: registration.deviceId },
            }).then((result) => {
              if (result._tag === "Failure") {
                Dialog.alert(gt("Test failed"), String(squashAtomCommandFailure(result)));
              }
            })
          }
        />
      ) : null}
      {registration.kind === "stopped" ? (
        <SettingsRow
          icon="bell.badge"
          label={gt("Turn on notifications on this phone")}
          disabled={!canRegister}
          onPress={() => void turnOn()}
        />
      ) : (
        <SettingsRow
          icon="slash.circle"
          label={gt("Stop notifications on this phone")}
          disabled={!canRegister}
          onPress={() => void stop()}
        />
      )}
    </>
  );
}

function senderText(
  status: ForkPushStatus | null,
  failed: boolean,
  hostEnvironmentId: EnvironmentId | null,
  hostLabel: string | null,
  resolve: MessageResolver,
): string {
  if (failed) return resolve(msg("This server has no push host support."));
  if (status === null) return resolve(msg("Checking…"));
  const host = hostLabel ?? status.host?.label ?? resolve(msg("the push host"));
  const sendsToHost =
    status.host !== null &&
    (hostEnvironmentId === null || status.host.environmentId === hostEnvironmentId);
  const expires = status.host ? new Date(status.host.linkExpiresAt).toLocaleDateString() : "";
  const text =
    status.role === "sender" && sendsToHost
      ? resolve(msg("Sends to {host}. Link expires {expires}.", { host, expires }))
      : sendsToHost && status.error !== null
        ? resolve(
            msg("Can't reach {host}: {error} Link it again to renew.", {
              host,
              error: status.error,
            }),
          )
        : resolve(msg("Not linked to {host}, so its threads don't notify.", { host }));
  return status.publishingOff ? `${text} ${resolve(PUBLISHING_OFF)}` : text;
}

function SenderRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly hostEnvironmentId: EnvironmentId | null;
  readonly hostLabel: string | null;
}) {
  const m = useMessages();
  const status = useEnvironmentQuery(
    forkPushEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  return (
    <SettingsRow
      icon="server.rack"
      label={props.label}
      value={senderText(
        status.data,
        status.failure !== null,
        props.hostEnvironmentId,
        props.hostLabel,
        m,
      )}
      valuePosition="below"
    />
  );
}
