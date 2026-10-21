import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import type { EnvironmentPowerSettings } from "../../persistence/mobile-preferences";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  defaultEnvironmentPowerSettings,
  setEnvironmentPowerSettings,
  useEnvironmentPowerSettings,
} from "./environment-power-state";

/** Per-environment sleep/wake setup in Settings → Environments → <environment>. */
export function EnvironmentPowerSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentPowerSettings()[props.environmentId];
  const environments = useWorkspaceEnvironments();
  const candidates = environments.filter(
    (environment) => environment.environmentId !== props.environmentId,
  );

  return (
    <SettingsSection
      title="Sleep and wake"
      footer={
        settings
          ? "Wake and sleep commands run in a shell on the machine you choose, which must be on the same network. Status comes from whether this environment connects."
          : undefined
      }
    >
      <SettingsSwitchRow
        icon="moon"
        label="Sleep and wake from home"
        subtitle="Adds a status chip above your threads. While this machine is asleep, T3 Code stops reconnecting to it."
        value={settings !== undefined}
        onValueChange={(enabled) =>
          setEnvironmentPowerSettings(
            props.environmentId,
            enabled
              ? defaultEnvironmentPowerSettings(
                  candidates.find((environment) => environment.connectionState === "connected")
                    ?.environmentId ?? null,
                )
              : null,
          )
        }
      />
      {settings ? (
        <PowerSettingsFields
          key={props.environmentId}
          environmentId={props.environmentId}
          settings={settings}
          candidates={candidates}
        />
      ) : null}
    </SettingsSection>
  );
}

function PowerSettingsFields(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: EnvironmentPowerSettings;
  readonly candidates: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly displayUrl: string;
  }>;
}) {
  const [wakeCommand, setWakeCommand] = useState(props.settings.wakeCommand);
  const [sleepCommand, setSleepCommand] = useState(props.settings.sleepCommand);
  const relay = props.candidates.find(
    (environment) => environment.environmentId === props.settings.relayEnvironmentId,
  );
  const save = (patch: Partial<EnvironmentPowerSettings>) =>
    setEnvironmentPowerSettings(props.environmentId, { ...props.settings, ...patch });
  const saveCommand = (key: "wakeCommand" | "sleepCommand", value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed !== props.settings[key]) save({ [key]: trimmed });
  };

  return (
    <>
      <Menu
        accessible
        accessibilityRole="button"
        accessibilityLabel="Send commands through"
        title="Send commands through"
        actions={props.candidates.map((environment) => ({
          id: environment.environmentId,
          title: environment.environmentLabel,
          subtitle: environment.displayUrl || undefined,
          state:
            environment.environmentId === props.settings.relayEnvironmentId
              ? ("on" as const)
              : ("off" as const),
        }))}
        onPressAction={({ nativeEvent }) => {
          const choice = props.candidates.find(
            (environment) => environment.environmentId === nativeEvent.event,
          );
          if (choice) save({ relayEnvironmentId: choice.environmentId });
        }}
      >
        <ListRowLayout
          icon="server.rack"
          label="Send commands through"
          description={relay?.environmentLabel ?? "Choose a machine on the same network"}
          disabled={props.candidates.length === 0}
          accessory={
            <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon-muted" />
          }
        />
      </Menu>
      <View className="gap-3 px-4 pb-4">
        <ConnectionFormField
          label="Wake command"
          autoCapitalize="none"
          autoCorrect={false}
          value={wakeCommand}
          onChangeText={setWakeCommand}
          onEndEditing={() => saveCommand("wakeCommand", wakeCommand)}
        />
        <ConnectionFormField
          label="Sleep command"
          autoCapitalize="none"
          autoCorrect={false}
          value={sleepCommand}
          onChangeText={setSleepCommand}
          onEndEditing={() => saveCommand("sleepCommand", sleepCommand)}
        />
      </View>
    </>
  );
}
