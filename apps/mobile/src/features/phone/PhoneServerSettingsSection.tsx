import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

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
import { openTermux } from "./termux";

/** Settings → Environments → <this phone>: the server that phone setup runs in Termux. */
export function PhoneServerSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const settings = usePhoneServerSettings();
  const runtime = usePhoneServerRuntime();
  const environment = useWorkspaceEnvironments().find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const [busy, setBusy] = useState<"stopping" | "updating" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  if (settings === null || settings.environmentId !== props.environmentId) return null;
  const connected = environment?.connectionState === "connected";

  return (
    <SettingsSection
      title="Phone server"
      footer={
        actionError ??
        runtime.error ??
        "T3 Code runs as a background task in Termux. Stop it here or with t3-phone stop in Termux; exiting Termux from its notification leaves it running. Its log is ~/.t3-phone/server.log."
      }
    >
      <ListRow
        icon="iphone"
        label="Setup and checks"
        description="Install, Claude sign-in and keep-alive settings"
        onPress={() => navigation.navigate("PhoneSetup")}
      />
      <SettingsSwitchRow
        icon="play"
        label="Start when T3 Code opens"
        subtitle="Starts the server in Termux if it isn't running."
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
          disabled={runtime.starting}
          onPress={() => void startAndReconnectPhoneServer(settings)}
        />
      )}
      <ListRow
        icon="arrow.down.circle"
        label={busy === "updating" ? "Updating…" : "Update T3 Code"}
        description="Installs the newest server build, then restarts the server."
        disabled={busy !== null || runtime.starting}
        onPress={() => {
          setBusy("updating");
          setActionError(null);
          updatePhoneServer(settings)
            .catch((error: unknown) =>
              setActionError(error instanceof Error ? error.message : "The update didn't finish."),
            )
            .finally(() => setBusy(null));
        }}
      />
      <ListRow icon="terminal" label="Open Termux" onPress={() => openTermux()} />
    </SettingsSection>
  );
}
