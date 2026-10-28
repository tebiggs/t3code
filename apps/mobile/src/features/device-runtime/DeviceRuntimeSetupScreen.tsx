import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Linking, PermissionsAndroid, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { setPhoneServerSettings, usePhoneServerSettings } from "../../state/phone-server-settings";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { confirmPhoneServerReplacement } from "../phone/confirmPhoneServerReplacement";
import {
  connectPhoneServer,
  forgetPhoneEnvironments,
  stopPhoneServerWhenSettled,
} from "../phone/phone-server";
import { StepRow, StepText } from "../phone/SetupStep";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  DEVICE_SERVER_PORT,
  inspectDeviceRuntime,
  requireDeviceRuntime,
  useDeviceRuntimeStatus,
  type DeviceRuntimeInspection,
  type DeviceRuntimeStatus,
} from "./device-runtime";

type StepId = "install" | "signIn" | "connect";

const STEPS: ReadonlyArray<StepId> = ["install", "signIn", "connect"];

const STEP_TITLES: Record<StepId, string> = {
  install: "Install Ubuntu, Claude Code and T3 Code",
  signIn: "Sign in to Claude",
  connect: "Connect this phone",
};

/** Progress shows in a notification while T3 Code is in the background; Android 13+ asks first. */
function requestNotifications(): Promise<unknown> {
  if (Platform.OS !== "android" || Platform.Version < 33) return Promise.resolve();
  return PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(
    () => undefined,
  );
}

/**
 * Android 11+ grants phone storage as All files access in system settings; older versions
 * ask with a dialog. Ubuntu sees it at /sdcard either way, once the grant lands.
 */
function requestStorageAccess(): Promise<unknown> {
  if (Platform.OS !== "android") return Promise.resolve();
  if (Platform.Version >= 30) {
    requireDeviceRuntime().openStorageSettings();
    return Promise.resolve();
  }
  return PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE).catch(
    () => undefined,
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** Phone setup: Ubuntu, Claude Code and the server run inside this app. */
export function DeviceRuntimeSetupScreen() {
  const native = requireDeviceRuntime();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { status, refresh } = useDeviceRuntimeStatus();
  const [inspection, setInspection] = useState<DeviceRuntimeInspection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const settings = usePhoneServerSettings();
  const environment =
    useWorkspaceEnvironments().find(
      (candidate) => candidate.environmentId === settings?.environmentId,
    ) ?? null;
  const connected = environment?.connectionState === "connected";

  const inspect = useCallback(() => {
    if (!native.getStatus().installed) {
      setInspection(null);
      return;
    }
    inspectDeviceRuntime()
      .then(setInspection)
      .catch((cause: unknown) => setError(errorText(cause, "Couldn't check the installation.")));
  }, [native]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      inspect();
    }, [refresh, inspect]),
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- re-reads Ubuntu once setup or sign-in finishes natively
  useEffect(() => {
    const job = native.addListener("onJob", (next) => {
      if (!next.running) inspect();
    });
    const login = native.addListener("onLogin", (next) => {
      if (next.state === "done") inspect();
    });
    return () => {
      job.remove();
      login.remove();
    };
  }, [native, inspect]);
  const installing = status.job?.running === true;

  const current: StepId | "ready" = !status.installed
    ? "install"
    : !inspection?.claudeSignedIn
      ? "signIn"
      : !connected
        ? "connect"
        : "ready";
  const stepState = (step: StepId): "done" | "current" | "upcoming" => {
    if (current === "ready") return "done";
    const index = STEPS.indexOf(step);
    const currentIndex = STEPS.indexOf(current);
    return index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
  };

  // A promise chain: React Compiler can't compile try/finally.
  const run = (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    return action()
      .catch((cause: unknown) => setError(errorText(cause, "That didn't finish.")))
      .then(() => {
        setBusy(null);
        refresh();
      });
  };
  // A failed install shows its error in the install step, from the job's state.
  const installRuntime = () =>
    requestNotifications()
      .then(() => native.install())
      .then(inspect, () => undefined);
  const install = () => run("install", installRuntime);
  // The server's environment goes with Ubuntu: its id lives in the deleted files.
  const forgetDeviceServer = async () => {
    setPhoneServerSettings(null);
    await forgetPhoneEnvironments(DEVICE_SERVER_PORT);
  };
  const reinstall = () =>
    Dialog.alert(
      "Reinstall?",
      "Deletes Ubuntu with everything in it, including the threads and Claude sign-in on this phone, then installs it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reinstall",
          style: "destructive",
          onPress: () =>
            void run("install", async () => {
              await stopPhoneServerWhenSettled();
              await native.remove();
              await forgetDeviceServer();
              setInspection(null);
              await installRuntime();
            }),
        },
      ],
    );
  const remove = () =>
    Dialog.alert(
      "Remove from this phone?",
      "Stops the server and deletes Ubuntu with everything in it, including the threads and Claude sign-in on this phone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            void run("remove", async () => {
              if (settings) setPhoneServerSettings({ ...settings, autoStart: false });
              await stopPhoneServerWhenSettled();
              await native.remove();
              await forgetDeviceServer();
              navigation.goBack();
            }),
        },
      ],
    );

  const summary: Record<StepId, string | undefined> = {
    install:
      inspection?.claudeVersion && inspection.t3Version
        ? `Claude Code ${inspection.claudeVersion} · T3 Code ${inspection.t3Version}`
        : undefined,
    signIn: inspection?.claudeSignedIn
      ? inspection.claudePlan
        ? `Signed in · ${inspection.claudePlan}`
        : "Signed in"
      : undefined,
    connect: environment ? `Connected as ${environment.environmentLabel}` : undefined,
  };
  const body: Record<StepId, ReactNode> = {
    install: (
      <InstallStepBody
        status={status}
        busy={busy === "install"}
        onInstall={() => void install()}
        onCancel={() => native.cancelJob()}
      />
    ),
    signIn: <SignInStepBody status={status} checking={status.installed && inspection === null} />,
    connect: (
      <>
        <StepText>Starts T3 Code's server on this phone and adds it to your environments.</StepText>
        <Button
          label="Connect"
          tone="primary"
          loading={busy === "connect"}
          onPress={() =>
            confirmPhoneServerReplacement(DEVICE_SERVER_PORT, () => {
              void run("connect", () => connectPhoneServer(DEVICE_SERVER_PORT));
            })
          }
        />
      </>
    ),
  };

  return (
    <SettingsScreen title="Run on this phone">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Claude Code and a T3 Code server run in an Ubuntu system inside T3 Code, so agents can
          work with your phone's files. Setup downloads about 400 MB and uses about 1.1 GB of
          storage. Use Wi-Fi.
        </Text>

        {current === "ready" && environment ? (
          <SettingsSection title="Ready">
            <View className="gap-3 p-4">
              <Text className="text-base font-t3-medium text-foreground">This phone is ready</Text>
              <Text className="text-sm text-foreground-muted">
                Connected as {environment.environmentLabel}
                {inspection?.claudeVersion ? ` · Claude Code ${inspection.claudeVersion}` : ""}
              </Text>
              <Button
                label="Start a thread"
                tone="primary"
                onPress={() => navigation.navigate("NewTaskProject")}
              />
            </View>
          </SettingsSection>
        ) : null}

        <SettingsSection title="Setup">
          {STEPS.map((step, index) => (
            <StepRow
              key={step}
              number={index + 1}
              title={STEP_TITLES[step]}
              state={stepState(step)}
              summary={summary[step]}
              action={
                step === "signIn" && inspection?.claudeSignedIn ? (
                  <Button
                    label="Sign out"
                    tone="text"
                    loading={busy === "logout"}
                    onPress={() =>
                      void run("logout", async () => {
                        await native.logout();
                        inspect();
                      })
                    }
                  />
                ) : null
              }
            >
              {stepState(step) === "current" ? body[step] : null}
            </StepRow>
          ))}
        </SettingsSection>

        {error ? (
          <Text selectable className="px-2 text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}

        {status.installed ? (
          <SettingsSection
            title="Keep it running"
            footer="While the server runs, T3 Code shows a notification and keeps the phone awake. Android may stop agents when many processes run; the child process setting lifts that limit."
          >
            <ListRow
              icon="internaldrive"
              label="Phone storage"
              description={
                status.storageAccess
                  ? "Allowed. Agents can reach /sdcard."
                  : "Not allowed. Agents can't reach your files."
              }
              onPress={() => void requestStorageAccess()}
            />
            <ListRow
              icon="bolt.circle"
              label="Battery use"
              description="Set T3 Code to Unrestricted if the server stops with the screen off."
              onPress={() => void Linking.openSettings()}
            />
            <ListRow
              icon="terminal"
              label="Child process limit"
              description='In Developer options, turn on "Disable child process restrictions".'
              onPress={() => native.openDeveloperSettings()}
            />
          </SettingsSection>
        ) : null}

        {status.installed ? (
          <SettingsSection>
            <ListRow
              icon="person.crop.circle"
              label="Agent access"
              description="Location, contacts, messages and more: ask, allow or never"
              onPress={() => navigation.navigate("AgentAccess")}
            />
          </SettingsSection>
        ) : null}

        {status.installed || status.job !== null ? (
          <SettingsSection title="Manage">
            <ListRow
              icon="terminal"
              label={showLog ? "Hide log" : "Show log"}
              description={installing ? "Setup output" : "Setup output and the server's log"}
              onPress={() => setShowLog((value) => !value)}
            />
            {showLog ? <LogView installing={installing} /> : null}
            {status.installed ? (
              <ListRow
                icon="arrow.clockwise"
                label="Reinstall"
                description="Deletes everything on this phone's server and installs it again."
                disabled={busy !== null || installing}
                onPress={reinstall}
              />
            ) : null}
            <ListRow
              icon="trash"
              label="Remove from this phone"
              description="Stops the server and deletes Ubuntu and everything in it."
              disabled={busy !== null || installing}
              onPress={remove}
            />
          </SettingsSection>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function InstallStepBody(props: {
  readonly status: DeviceRuntimeStatus;
  readonly busy: boolean;
  readonly onInstall: () => void;
  readonly onCancel: () => void;
}) {
  const job = props.status.job;
  if (job?.running) {
    return (
      <>
        <StepText>
          Step {job.stepNumber} of {job.stepCount}: {job.stepTitle}. It takes a few minutes; you can
          leave T3 Code, and a notification shows the progress.
        </StepText>
        <Button label="Cancel" tone="text" onPress={props.onCancel} />
      </>
    );
  }
  return (
    <>
      {job?.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {job.error}
        </Text>
      ) : null}
      <StepText>
        It runs in the background, with a notification. Running it again skips finished parts.
      </StepText>
      <Button
        label={job?.error ? "Try again" : "Install"}
        tone="primary"
        loading={props.busy}
        onPress={props.onInstall}
      />
    </>
  );
}

function SignInStepBody(props: {
  readonly status: DeviceRuntimeStatus;
  readonly checking: boolean;
}) {
  const native = requireDeviceRuntime();
  const [code, setCode] = useState("");
  const login = props.status.login;
  if (props.checking) return <StepText>Checking…</StepText>;
  if (login?.state === "starting") return <StepText>Starting sign-in…</StepText>;
  if (login?.state === "browser") {
    const manualUrl = login.manualUrl ?? "";
    return (
      <>
        <StepText>
          Sign in in your browser. If it shows a code instead of coming back here, copy it and paste
          it below.
        </StepText>
        <AppTextInput
          accessibilityLabel="Sign-in code"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Code"
          value={code}
          onChangeText={setCode}
        />
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Submit code"
            tone="primary"
            disabled={code.trim().length === 0}
            onPress={() => {
              native.submitLoginCode(code);
              setCode("");
            }}
          />
          {login.manualUrl ? (
            <Button
              label="Open again"
              tone="text"
              onPress={() => void Linking.openURL(manualUrl)}
            />
          ) : null}
          <Button label="Cancel" tone="text" onPress={() => native.cancelLogin()} />
        </View>
      </>
    );
  }
  return (
    <>
      {login?.state === "failed" ? (
        <Text selectable className="text-sm text-danger-foreground">
          {login.message}
        </Text>
      ) : null}
      <StepText>
        Use the Claude account that has Claude Code. Your browser opens to sign in.
      </StepText>
      <Button
        label="Sign in"
        tone="primary"
        onPress={() => void requestNotifications().then(() => native.startLogin())}
      />
    </>
  );
}

function LogView(props: { readonly installing: boolean }) {
  const native = requireDeviceRuntime();
  const job = native.getJobLog().slice(-60).join("\n");
  const server = props.installing ? "" : native.serverLog(40);
  return (
    <View className="gap-2 px-4 pb-3">
      {job ? (
        <Text selectable className="font-mono text-[11px] leading-4 text-foreground-muted">
          {job}
        </Text>
      ) : null}
      {server ? (
        <Text selectable className="font-mono text-[11px] leading-4 text-foreground-muted">
          {server}
        </Text>
      ) : null}
      {!job && !server ? <StepText>Nothing logged yet.</StepText> : null}
    </View>
  );
}
