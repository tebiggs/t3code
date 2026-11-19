import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import type { EnvironmentPowerSettings } from "../../persistence/mobile-preferences";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { normalizeMacAddress, parseLocalAddress } from "./environment-power";
import {
  defaultEnvironmentPowerSettings,
  setEnvironmentPowerSettings,
  useEnvironmentPowerSettings,
} from "./environment-power-state";

/** Per-environment sleep/wake setup in Settings → Environments → <environment>. */
export function EnvironmentPowerSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const settings = useEnvironmentPowerSettings()[props.environmentId];
  const environments = useWorkspaceEnvironments();
  const candidates = environments.filter(
    (environment) => environment.environmentId !== props.environmentId,
  );

  return (
    <SettingsSection
      title={gt("Sleep and wake")}
      footer={
        settings
          ? gt(
              "Wake sends a Wake-on-LAN packet from the machine you choose, which must be on the same network and have {python} (or PowerShell on Windows). Sleep runs on this machine through its own connection. Custom commands replace either one and run on the chosen machine.",
              { python: "python3" },
            )
          : undefined
      }
    >
      <SettingsSwitchRow
        icon="moon"
        label={gt("Sleep and wake from home")}
        subtitle={gt(
          "Adds a status chip above your threads. While this machine is asleep, T3 Code stops reconnecting to it.",
        )}
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
  const gt = useGT();
  const [macAddress, setMacAddress] = useState(props.settings.macAddress ?? "");
  const [localAddress, setLocalAddress] = useState(props.settings.localAddress ?? "");
  const [wakeCommand, setWakeCommand] = useState(props.settings.wakeCommand);
  const [sleepCommand, setSleepCommand] = useState(props.settings.sleepCommand);
  const relay = props.candidates.find(
    (environment) => environment.environmentId === props.settings.relayEnvironmentId,
  );
  const save = (patch: Partial<EnvironmentPowerSettings>) =>
    setEnvironmentPowerSettings(props.environmentId, { ...props.settings, ...patch });
  // Empty is meaningful: it switches back to the built-in command.
  const saveCommand = (key: "wakeCommand" | "sleepCommand", value: string) => {
    const trimmed = value.trim();
    if (trimmed !== props.settings[key]) save({ [key]: trimmed });
  };
  const macInvalid = macAddress.trim().length > 0 && normalizeMacAddress(macAddress) === null;
  const saveMacAddress = () => {
    const normalized = macAddress.trim().length === 0 ? "" : normalizeMacAddress(macAddress);
    if (normalized === null) return;
    setMacAddress(normalized);
    if (normalized !== (props.settings.macAddress ?? "")) save({ macAddress: normalized });
  };
  const trimmedLocalAddress = localAddress.trim();
  const localAddressInvalid =
    trimmedLocalAddress.length > 0 && parseLocalAddress(trimmedLocalAddress) === null;
  const saveLocalAddress = () => {
    if (localAddressInvalid) return;
    setLocalAddress(trimmedLocalAddress);
    if (trimmedLocalAddress !== (props.settings.localAddress ?? "")) {
      save({ localAddress: trimmedLocalAddress });
    }
  };

  return (
    <>
      <Menu
        accessible
        accessibilityRole="button"
        accessibilityLabel={gt("Wake through")}
        title={gt("Wake through")}
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
          label={gt("Wake through")}
          description={relay?.environmentLabel ?? gt("Choose a machine on the same network")}
          disabled={props.candidates.length === 0}
          accessory={
            <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon-muted" />
          }
        />
      </Menu>
      <View className="gap-3 px-4 pb-4">
        <View className="gap-1">
          <ConnectionFormField
            label={gt("MAC address")}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="1a:2b:3c:4d:5e:6f"
            value={macAddress}
            onChangeText={setMacAddress}
            onEndEditing={saveMacAddress}
          />
          <Text textRole="label" className="px-1 text-foreground-muted">
            {macInvalid
              ? gt("Enter 12 hex digits, for example {example}.", { example: "1a:2b:3c:4d:5e:6f" })
              : gt(
                  "The wired network adapter of this machine. On Windows, run {windowsCommand}; on macOS or Linux, {linuxCommand} or {otherCommand}.",
                  {
                    windowsCommand: "getmac /v",
                    linuxCommand: "ip link",
                    otherCommand: "ifconfig",
                  },
                )}
          </Text>
        </View>
        <View className="gap-1">
          <ConnectionFormField
            label={gt("Local address (optional)")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={gt("{address} or {addressWithPort}", {
              address: "192.168.1.20",
              addressWithPort: "192.168.1.20:3773",
            })}
            value={localAddress}
            onChangeText={setLocalAddress}
            onEndEditing={saveLocalAddress}
          />
          <Text textRole="label" className="px-1 text-foreground-muted">
            {localAddressInvalid
              ? gt("Enter a host name or IPv4 address, with an optional {port}.", { port: ":port" })
              : gt(
                  "Lets the machine you wake through tell within seconds whether this one is asleep when the app starts. In T3 Code on this machine, turn on Network access, and let the port ({port} unless you add one) through its firewall.",
                  { port: "3773" },
                )}
          </Text>
        </View>
        <ConnectionFormField
          label={gt("Custom wake command (optional)")}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={gt("Built-in Wake-on-LAN")}
          value={wakeCommand}
          onChangeText={setWakeCommand}
          onEndEditing={() => saveCommand("wakeCommand", wakeCommand)}
        />
        <ConnectionFormField
          label={gt("Custom sleep command (optional)")}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={gt("Built-in sleep on this machine")}
          value={sleepCommand}
          onChangeText={setSleepCommand}
          onEndEditing={() => saveCommand("sleepCommand", sleepCommand)}
        />
      </View>
    </>
  );
}
