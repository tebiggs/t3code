import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { ListRow } from "../../components/ui/ListRow";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { setPhoneServerSettings, usePhoneServerSettings } from "../../state/phone-server-settings";
import {
  startAndReconnectPhoneServer,
  stopPhoneServerWhenSettled,
  updatePhoneServer,
  usePhoneServerRuntime,
} from "./phone-server";
import { inspectDeviceRuntime } from "../device-runtime/device-runtime";

interface ClaudeSignIn {
  readonly signedIn: boolean;
  readonly plan: string | null;
}

function useClaudeSignIn() {
  const [claude, setClaude] = useState<ClaudeSignIn | null>(null);
  const check = useCallback(() => {
    inspectDeviceRuntime().then(
      (inspection) =>
        setClaude({ signedIn: inspection.claudeSignedIn, plan: inspection.claudePlan }),
      () => undefined,
    );
  }, []);
  useFocusEffect(check);
  return { claude, check };
}

/** Settings → Environments → <this phone>: the server phone setup runs inside this app. */
export function PhoneServerSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const settings = usePhoneServerSettings();
  const runtime = usePhoneServerRuntime();
  const environment = useWorkspaceEnvironments().find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const [busy, setBusy] = useState<"stopping" | "updating" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const server = useClaudeSignIn();
  if (settings === null || settings.environmentId !== props.environmentId) return null;
  const connected = environment?.connectionState === "connected";

  return (
    <SettingsSection
      title="Phone server"
      footer={
        actionError ??
        runtime.error ??
        (server.claude?.signedIn === false
          ? "Claude Code is signed out on this phone, so Claude threads here will fail. Sign in from phone setup."
          : null) ??
        "T3 Code runs inside this app, with a notification while it runs. Stop it here or from the notification."
      }
    >
      <ListRow
        icon="iphone"
        label="Setup and checks"
        description="Install, Claude sign-in, phone storage and removal"
        onPress={() => navigation.navigate("PhoneSetup")}
      />
      {server.claude ? (
        <ListRow
          icon="person.crop.circle"
          label="Claude Code"
          description={
            server.claude.signedIn
              ? server.claude.plan
                ? `Signed in · ${server.claude.plan}`
                : "Signed in"
              : "Signed out. Sign in from phone setup."
          }
          onPress={() => navigation.navigate("PhoneSetup")}
        />
      ) : null}
      <SettingsSwitchRow
        icon="play"
        label="Start when T3 Code opens"
        subtitle="Starts the server on this phone if it isn't running."
        value={settings.autoStart}
        onValueChange={(autoStart) => setPhoneServerSettings({ ...settings, autoStart })}
      />
      {connected ? (
        <ListRow
          icon="stop.fill"
          label={busy === "stopping" ? "Stopping…" : "Stop server"}
          description="Also turns off starting when T3 Code opens."
          disabled={busy !== null}
          onPress={() => {
            setBusy("stopping");
            setActionError(null);
            setPhoneServerSettings({ ...settings, autoStart: false });
            stopPhoneServerWhenSettled()
              .catch((error: unknown) =>
                setActionError(
                  error instanceof Error ? error.message : "Couldn't stop the server.",
                ),
              )
              .finally(() => setBusy(null));
          }}
        />
      ) : (
        <ListRow
          icon="play"
          label={runtime.starting ? "Starting…" : "Start server"}
          disabled={runtime.starting || busy !== null}
          onPress={() => void startAndReconnectPhoneServer(settings)}
        />
      )}
      <ListRow
        icon="arrow.down.circle"
        label={busy === "updating" ? "Updating…" : "Update T3 Code and Claude Code"}
        description="Installs the newest server build and Claude Code, then restarts the server."
        disabled={busy !== null || runtime.starting}
        onPress={() => {
          setBusy("updating");
          setActionError(null);
          updatePhoneServer(settings)
            .catch((error: unknown) =>
              setActionError(error instanceof Error ? error.message : "The update didn't finish."),
            )
            .finally(() => {
              setBusy(null);
              server.check();
            });
        }}
      />
    </SettingsSection>
  );
}
