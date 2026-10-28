import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { ListRow } from "../../components/ui/ListRow";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { setPhoneServerSettings, usePhoneServerSettings } from "../../state/phone-server-settings";
import {
  probePhone,
  startAndReconnectPhoneServer,
  stopPhoneServerWhenSettled,
  updatePhoneServer,
  usePhoneServerRuntime,
} from "./phone-server";
import { UPSTREAM_SERVER_WARNING, type PhoneScriptStatus } from "./phone-setup";
import { inspectDeviceRuntime } from "../device-runtime/device-runtime";
import { openTermux } from "./termux";

interface ClaudeSignIn {
  readonly signedIn: boolean;
  readonly plan: string | null;
}

// The on-device runtime only installs this fork's builds, so only Termux reports one.
function usePhoneServerStatus(termux: boolean) {
  const [build, setBuild] = useState<PhoneScriptStatus["t3Build"]>(null);
  const [claude, setClaude] = useState<ClaudeSignIn | null>(null);
  const check = useCallback(() => {
    if (termux) {
      void probePhone().then((probe) => {
        if (probe.kind !== "ok") return;
        setBuild(probe.status.t3Build);
        setClaude({ signedIn: probe.status.claudeSignedIn, plan: probe.status.claudePlan });
      });
    } else {
      inspectDeviceRuntime().then(
        (inspection) =>
          setClaude({ signedIn: inspection.claudeSignedIn, plan: inspection.claudePlan }),
        () => undefined,
      );
    }
  }, [termux]);
  useFocusEffect(check);
  return { build, claude, check };
}

/** Settings → Environments → <this phone>: the server phone setup runs in Termux or in this app. */
export function PhoneServerSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const settings = usePhoneServerSettings();
  const runtime = usePhoneServerRuntime();
  const environment = useWorkspaceEnvironments().find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const [busy, setBusy] = useState<"stopping" | "updating" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const termux = settings?.host !== "device";
  const server = usePhoneServerStatus(termux);
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
        (server.build === "upstream" ? UPSTREAM_SERVER_WARNING : null) ??
        (termux
          ? "T3 Code runs as a background task in Termux. Stop it here or with t3-phone stop in Termux; exiting Termux from its notification leaves it running. Its log is ~/.t3-phone/server.log."
          : "T3 Code runs inside this app, with a notification while it runs. Stop it here or from the notification.")
      }
    >
      <ListRow
        icon="iphone"
        label="Setup and checks"
        description={
          termux
            ? "Install, Claude sign-in and keep-alive settings"
            : "Install, Claude sign-in, log and removal"
        }
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
        subtitle={`Starts the server ${termux ? "in Termux" : "on this phone"} if it isn't running.`}
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
        label={
          busy === "updating"
            ? "Updating…"
            : termux
              ? "Update T3 Code"
              : "Update T3 Code and Claude Code"
        }
        description={
          !termux
            ? "Installs the newest server build and Claude Code, then restarts the server."
            : server.build === "upstream"
              ? "Runs upstream's server. Installs this app's newest server build, then restarts."
              : "Installs the newest server build, then restarts the server."
        }
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
      {termux ? <ListRow icon="terminal" label="Open Termux" onPress={() => openTermux()} /> : null}
    </SettingsSection>
  );
}
