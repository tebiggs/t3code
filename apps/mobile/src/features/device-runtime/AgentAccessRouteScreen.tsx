import { msg, T, useGT, useMessages } from "gt-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, PermissionsAndroid } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { deviceRuntime, type AgentAccessCategory, type AgentAccessPolicy } from "./device-runtime";

const CATEGORIES: Readonly<Record<string, { readonly label: string; readonly commands: string }>> =
  {
    location: { label: msg("Location"), commands: "termux-location, termux-telephony-cellinfo" },
    camera: { label: msg("Camera"), commands: "termux-camera-photo" },
    microphone: { label: msg("Microphone"), commands: "termux-microphone-record" },
    contacts: { label: msg("Contacts"), commands: "termux-contact-list" },
    sms: { label: msg("Text messages"), commands: "termux-sms-list, termux-sms-send" },
    "call-log": { label: msg("Call log"), commands: "termux-call-log" },
    phone: {
      label: msg("Phone calls and device info"),
      commands: "termux-telephony-call, termux-telephony-deviceinfo",
    },
    notifications: { label: msg("Notifications"), commands: "termux-notification-list" },
    apps: { label: msg("Other apps"), commands: "am (also termux-am), pm" },
  };

const POLICIES: ReadonlyArray<{
  readonly policy: AgentAccessPolicy;
  readonly label: string;
  readonly description: string;
}> = [
  {
    policy: "ask",
    label: msg("Ask each time"),
    description: msg("This phone asks you before each command runs."),
  },
  {
    policy: "allow",
    label: msg("Always allow"),
    description: msg("Agents use it without asking."),
  },
  {
    policy: "deny",
    label: msg("Never", { $context: "agent access policy" }),
    description: msg("These commands are refused."),
  },
];

/** Asks Android for what a category needs; notification access is a system settings page. */
function requestAndroidAccess(category: AgentAccessCategory): Promise<unknown> {
  if (category.permissions.length === 0) {
    deviceRuntime?.openNotificationAccessSettings();
    return Promise.resolve();
  }
  return PermissionsAndroid.requestMultiple([...category.permissions]).then(
    (results) => {
      // Android stops asking after two refusals; then only T3 Code's App info can allow it.
      if (Object.values(results).includes(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) {
        void Linking.openSettings();
      }
    },
    () => undefined,
  );
}

/** Settings → Agent access: what agents on this phone may reach through Android. */
export function AgentAccessRouteScreen() {
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const m = useMessages();
  const read = useCallback(() => deviceRuntime?.getAgentAccess() ?? [], []);
  const [categories, setCategories] = useState(read);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads grants made in Android's settings
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setCategories(read());
    });
    return () => subscription.remove();
  }, [read]);

  const choose = (category: AgentAccessCategory, policy: AgentAccessPolicy) => {
    deviceRuntime?.setAgentAccess(category.id, policy);
    setCategories(read());
    if (policy !== "deny" && !category.granted) {
      void requestAndroidAccess(category).then(() => setCategories(read()));
    }
  };

  return (
    <SettingsScreen title={gt("Agent access")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          <T>
            Agents on this phone reach Android through termux-* commands. These need your say: with
            Ask each time, this phone asks you before each one runs, even when another device
            started it. Nobody answering within a minute counts as no. This covers those commands.
            It isn't a hard barrier against someone using a terminal on this phone's server.
          </T>
        </Text>
        {categories.map((category) => {
          const meta = CATEGORIES[category.id];
          if (meta === undefined) return null;
          return (
            <SettingsSection
              key={category.id}
              title={m(meta.label)}
              footer={
                category.policy === "deny"
                  ? meta.commands
                  : category.granted
                    ? gt("{commands}. Android allows it.", { commands: meta.commands })
                    : gt("{commands}. Android hasn't allowed T3 Code yet.", {
                        commands: meta.commands,
                      })
              }
            >
              {POLICIES.map((choice, index) => (
                <ListChoiceRow
                  key={choice.policy}
                  label={m(choice.label)}
                  description={m(choice.description)}
                  selected={category.policy === choice.policy}
                  separated={index > 0}
                  onPress={() => choose(category, choice.policy)}
                />
              ))}
              {category.policy !== "deny" && !category.granted ? (
                <ListRow
                  icon="exclamationmark.circle"
                  label={gt("Allow in Android")}
                  onPress={() =>
                    void requestAndroidAccess(category).then(() => setCategories(read()))
                  }
                />
              ) : null}
            </SettingsSection>
          );
        })}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
