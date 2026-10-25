import { useFocusEffect, useNavigation } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { setPhoneServerSettings, usePhoneServerSettings } from "../../state/phone-server-settings";
import { connectPhoneServer, probePhone } from "./phone-server";
import {
  currentPhoneSetupStep,
  PHONE_SCRIPT_VERSION,
  PHONE_SETUP_STEPS,
  phoneInstallState,
  type PhoneProbe,
  type PhoneScriptStatus,
  type PhoneSetupStepId,
} from "./phone-setup";
import {
  getTermuxStatus,
  openDeveloperSettings,
  openTermux,
  openTermuxDownload,
  openTermuxSettings,
  requestRunCommandPermission,
  runPhoneScript,
  startPhoneScriptSession,
  supportsPhoneSetup,
  type TermuxStatus,
} from "./termux";

export const ALLOW_EXTERNAL_APPS_COMMAND =
  "mkdir -p ~/.termux && echo 'allow-external-apps = true' >> ~/.termux/termux.properties && termux-reload-settings";

const INSTALL_RECHECK_MS = 15_000;

const STEP_TITLES: Record<PhoneSetupStepId, string> = {
  termux: "Install Termux",
  permission: "Let T3 Code use Termux",
  install: "Install Ubuntu, Claude Code and T3 Code",
  signIn: "Sign in to Claude",
  connect: "Connect this phone",
};

function usePhoneSetupState() {
  const [termux, setTermux] = useState<TermuxStatus>(() => getTermuxStatus());
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  const [probe, setProbe] = useState<PhoneProbe>({ kind: "none" });
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);

  const refresh = useCallback(async () => {
    const next = getTermuxStatus();
    setTermux(next);
    if (!next.installed || !next.permissionGranted || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    const result = await probePhone();
    checkingRef.current = false;
    setChecking(false);
    setProbe(result);
    // The saved t3-phone is for people at the Termux prompt; keep it in step with the app.
    const launcher = result.kind === "ok" ? result.status.launcherVersion : null;
    if (launcher !== null && launcher < PHONE_SCRIPT_VERSION) {
      void runPhoneScript(["save-launcher"], 30_000).catch(() => undefined);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const installRunning = probe.kind === "ok" && phoneInstallState(probe.status).kind === "running";
  useEffect(() => {
    if (!installRunning) return;
    const interval = setInterval(() => void refresh(), INSTALL_RECHECK_MS);
    return () => clearInterval(interval);
  }, [installRunning, refresh]);

  const requestPermission = useCallback(async () => {
    const result = await requestRunCommandPermission();
    setPermissionBlocked(result === "blocked");
    await refresh();
  }, [refresh]);

  return { termux, permissionBlocked, probe, checking, refresh, requestPermission };
}

/** Finds the saved environment the phone's server belongs to, and records it once known. */
function usePhoneEnvironment(status: PhoneScriptStatus | null) {
  const settings = usePhoneServerSettings();
  const environments = useWorkspaceEnvironments();
  const environmentId = status?.environmentId ?? settings?.environmentId ?? null;
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  useEffect(() => {
    if (environment === null || status === null) return;
    if (settings?.environmentId === environment.environmentId && settings.port === status.port) {
      return;
    }
    setPhoneServerSettings({
      environmentId: environment.environmentId,
      port: status.port,
      autoStart: settings?.autoStart ?? true,
    });
  }, [environment, settings, status]);
  return environment;
}

/** Deep links reach this route on iOS too, where there is no Termux bridge. */
export function PhoneSetupRouteScreen() {
  return supportsPhoneSetup() ? <PhoneSetupScreen /> : <PhoneSetupUnavailable />;
}

function PhoneSetupUnavailable() {
  return (
    <SettingsScreen title="Run on this phone">
      <Text className="px-7 pt-4 text-sm text-foreground-muted">
        Running agents on the phone itself needs the Android app.
      </Text>
    </SettingsScreen>
  );
}

function PhoneSetupScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const setup = usePhoneSetupState();
  const status = setup.probe.kind === "ok" ? setup.probe.status : null;
  const environment = usePhoneEnvironment(status);
  const connected = environment?.connectionState === "connected";
  const permission = setup.termux.permissionGranted
    ? "granted"
    : setup.permissionBlocked
      ? "blocked"
      : "denied";
  const current = currentPhoneSetupStep({
    termuxInstalled: setup.termux.installed,
    permission,
    probe: setup.probe,
    connected,
  });
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<void> | void) => {
    setBusy(label);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
    void setup.refresh();
  };
  const appComponent = setup.termux.appLaunchComponent ?? "";
  const session = (args: ReadonlyArray<string>, label: string) =>
    run(label, () => startPhoneScriptSession(args, label));

  const stepState = (step: PhoneSetupStepId): "done" | "current" | "upcoming" => {
    if (current === "ready") return "done";
    const index = PHONE_SETUP_STEPS.indexOf(step);
    const currentIndex = PHONE_SETUP_STEPS.indexOf(current);
    return index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
  };

  const body: Record<PhoneSetupStepId, ReactNode> = {
    termux: (
      <>
        <StepText>
          Download it from F-Droid. If Chrome asks, allow installing from this source. The Play
          Store version can't run the Ubuntu tools.
        </StepText>
        <Button label="Get Termux" tone="primary" onPress={() => void openTermuxDownload()} />
      </>
    ),
    permission: (
      <PermissionStepBody
        termux={setup.termux}
        blocked={setup.permissionBlocked}
        probe={setup.probe}
        checking={setup.checking}
        onAllow={() => void setup.requestPermission()}
        onCopyAndOpen={() =>
          void run("copy", async () => {
            await Clipboard.setStringAsync(ALLOW_EXTERNAL_APPS_COMMAND);
            openTermux();
          })
        }
      />
    ),
    install: status ? (
      <InstallStepBody
        status={status}
        busy={busy === "T3 Code setup"}
        onInstall={() =>
          void session(["install", appComponent, setup.termux.deviceName], "T3 Code setup")
        }
        onOpenTermux={() => openTermux()}
      />
    ) : null,
    signIn: (
      <>
        <StepText>
          Termux opens Claude's sign-in. Follow the link, sign in with your Claude account, copy the
          code it shows and paste it into Termux. Then come back here.
        </StepText>
        <Button
          label="Sign in in Termux"
          tone="primary"
          loading={busy === "Claude sign-in"}
          onPress={() => void session(["login", appComponent], "Claude sign-in")}
        />
        <StepText>Or open Termux yourself and run:</StepText>
        <CodeBlock>{"t3-phone shell\nclaude auth login"}</CodeBlock>
      </>
    ),
    connect: status ? (
      <>
        <StepText>
          Starts T3 Code in the background in Termux and adds this phone as an environment. The
          first start can take a minute.
        </StepText>
        <Button
          label={busy === "connect" ? "Starting…" : "Connect"}
          tone="primary"
          loading={busy === "connect"}
          onPress={() =>
            void run("connect", async () => {
              await connectPhoneServer(status.port);
            })
          }
        />
      </>
    ) : null,
  };

  return (
    <SettingsScreen
      title="Run on this phone"
      actions={[
        {
          accessibilityLabel: "Check again",
          icon: "arrow.clockwise",
          loading: setup.checking,
          onPress: () => void setup.refresh(),
        },
      ]}
    >
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Claude Code and a T3 Code server run inside Termux on this phone, so agents can work with
          your phone's files. Setup takes about 20 minutes and 3 GB of storage. Use Wi-Fi.
        </Text>

        {current === "ready" && environment ? (
          <SettingsSection title="Ready">
            <View className="gap-3 p-4">
              <Text className="text-base font-t3-medium text-foreground">This phone is ready</Text>
              <Text className="text-sm text-foreground-muted">
                Connected as {environment.environmentLabel}
                {status?.claudeVersion ? ` · Claude Code ${status.claudeVersion}` : ""}
              </Text>
              <Button
                label="Start a thread"
                tone="primary"
                onPress={() => navigation.navigate("NewTaskProject")}
              />
            </View>
          </SettingsSection>
        ) : null}

        {current !== "ready" || showSteps ? (
          <SettingsSection title="Setup">
            {PHONE_SETUP_STEPS.map((step, index) => (
              <StepRow
                key={step}
                number={index + 1}
                title={STEP_TITLES[step]}
                state={stepState(step)}
                summary={stepSummary(step, setup.termux, status, environment?.environmentLabel)}
                action={
                  step === "signIn" && status?.claudeSignedIn ? (
                    <Button
                      label="Sign out"
                      tone="text"
                      loading={busy === "logout"}
                      onPress={() =>
                        void run("logout", async () => {
                          await runPhoneScript(["logout"], 60_000);
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
        ) : (
          <Button label="Show setup steps" tone="text" onPress={() => setShowSteps(true)} />
        )}

        {actionError ? (
          <Text selectable className="px-2 text-sm text-danger-foreground">
            {actionError}
          </Text>
        ) : null}

        {status?.ubuntu ? (
          <KeepRunningSection
            termux={setup.termux}
            status={status}
            onAllowStorage={() => void session(["storage", appComponent], "Phone storage")}
          />
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function stepSummary(
  step: PhoneSetupStepId,
  termux: TermuxStatus,
  status: PhoneScriptStatus | null,
  environmentLabel: string | undefined,
): string | undefined {
  switch (step) {
    case "termux":
      return termux.versionName ? `Termux ${termux.versionName}` : undefined;
    case "permission":
      return undefined;
    case "install":
      return status?.claudeVersion && status.t3Version
        ? `Claude Code ${status.claudeVersion} · T3 Code ${status.t3Version}`
        : undefined;
    case "signIn":
      return status?.claudeSignedIn
        ? status.claudePlan
          ? `Signed in · ${status.claudePlan}`
          : "Signed in"
        : undefined;
    case "connect":
      return environmentLabel ? `Connected as ${environmentLabel}` : undefined;
  }
}

function PermissionStepBody(props: {
  readonly termux: TermuxStatus;
  readonly blocked: boolean;
  readonly probe: PhoneProbe;
  readonly checking: boolean;
  readonly onAllow: () => void;
  readonly onCopyAndOpen: () => void;
}) {
  if (!props.termux.permissionGranted) {
    return props.blocked ? (
      <>
        <StepText>
          Android stopped asking. In T3 Code's app settings, open Permissions, then allow "Run
          commands in Termux environment".
        </StepText>
        <Button
          label="Open app settings"
          tone="primary"
          onPress={() => void Linking.openSettings()}
        />
      </>
    ) : (
      <>
        <StepText>Allow T3 Code to run commands in Termux.</StepText>
        <Button label="Allow" tone="primary" onPress={props.onAllow} />
      </>
    );
  }
  const problem =
    props.probe.kind === "refused"
      ? `Termux didn't accept the command: ${props.probe.message}`
      : props.probe.kind === "timeout"
        ? "Termux didn't answer. Open Termux once, wait for the $ prompt, then check again."
        : props.probe.kind === "failed"
          ? props.probe.message
          : null;
  return (
    <>
      <StepText>
        Termux also has to accept commands from other apps. Open Termux, wait for the $ prompt,
        long-press, paste this, press Enter, then come back:
      </StepText>
      <CodeBlock>{ALLOW_EXTERNAL_APPS_COMMAND}</CodeBlock>
      {props.checking ? <StepText>Checking…</StepText> : null}
      {problem && !props.checking ? (
        <Text selectable className="text-sm text-danger-foreground">
          {problem}
        </Text>
      ) : null}
      <Button label="Copy and open Termux" tone="primary" onPress={props.onCopyAndOpen} />
    </>
  );
}

function InstallStepBody(props: {
  readonly status: PhoneScriptStatus;
  readonly busy: boolean;
  readonly onInstall: () => void;
  readonly onOpenTermux: () => void;
}) {
  const install = phoneInstallState(props.status);
  const found = [
    props.status.ubuntu ? "Ubuntu" : null,
    props.status.claudeVersion ? `Claude Code ${props.status.claudeVersion}` : null,
    props.status.t3Version ? `T3 Code ${props.status.t3Version}` : null,
  ].filter((part): part is string => part !== null);
  if (install.kind === "running") {
    return (
      <>
        <StepText>
          Installing in Termux, step {install.step} of {install.total}: {install.message}. This
          screen checks again every few seconds.
        </StepText>
        <Button label="Open Termux" tone="primary" onPress={props.onOpenTermux} />
      </>
    );
  }
  return (
    <>
      {install.kind === "failed" ? (
        <Text selectable className="text-sm text-danger-foreground">
          Setup stopped at step {install.step} of {install.total}: {install.message}
        </Text>
      ) : (
        <StepText>
          Termux opens and downloads about 1.5 GB, which takes 10–20 minutes. If Android asks Termux
          for storage access, allow it. Keep Termux open; it brings you back here when it says Done.
        </StepText>
      )}
      {found.length > 0 ? (
        <StepText>
          Already here: {found.join(", ")}. Setup keeps them, along with your Claude sign-in.
        </StepText>
      ) : null}
      <Button
        label={
          install.kind === "failed"
            ? "Try again"
            : install.kind === "partial" || found.length > 0
              ? "Finish install"
              : "Install in Termux"
        }
        tone="primary"
        loading={props.busy}
        onPress={props.onInstall}
      />
    </>
  );
}

function KeepRunningSection(props: {
  readonly termux: TermuxStatus;
  readonly status: PhoneScriptStatus;
  readonly onAllowStorage: () => void;
}) {
  const samsung = props.termux.manufacturer.toLowerCase() === "samsung";
  return (
    <SettingsSection
      title="Keep it running"
      footer="Even with these, Android can stop Termux when the phone runs low on memory. T3 Code starts it again when you open the app."
    >
      <ListRow
        icon="internaldrive"
        label="Phone storage"
        description={
          props.status.storage
            ? "Allowed. Agents can reach /sdcard."
            : "Not allowed. Agents can't reach your files."
        }
        onPress={props.onAllowStorage}
      />
      <ListRow
        icon="bolt.circle"
        label="Termux battery use"
        description={
          props.termux.batteryUnrestricted
            ? "Unrestricted"
            : "Optimized. Set it to Unrestricted so the server runs with the screen off."
        }
        onPress={() => openTermuxSettings()}
      />
      <ListRow
        icon="terminal"
        label="Child process limit"
        description={
          props.termux.developerOptionsEnabled
            ? 'In Developer options, turn on "Disable child process restrictions" so Android doesn\'t stop long agent runs.'
            : 'Turn on Developer options (tap Build number 7 times), then turn on "Disable child process restrictions".'
        }
        onPress={() => openDeveloperSettings()}
      />
      {samsung ? (
        <ListRow
          icon="moon"
          label="Never sleeping apps"
          description="Samsung: Settings › Battery › Background usage limits › Never sleeping apps › add Termux."
          onPress={() => openTermuxSettings()}
        />
      ) : null}
    </SettingsSection>
  );
}

function StepRow(props: {
  readonly number: number;
  readonly title: string;
  readonly state: "done" | "current" | "upcoming";
  readonly summary: string | undefined;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View
      accessible={props.children === null}
      accessibilityLabel={`Step ${props.number}, ${props.title}, ${props.state === "done" ? "done" : props.state === "current" ? "current step" : "not started"}`}
      className="flex-row gap-3 px-4 py-3"
    >
      <View
        className={cn(
          "mt-0.5 size-6 items-center justify-center rounded-full",
          props.state === "done" && "bg-adaptive-emerald-600-400",
          props.state === "current" && "bg-primary",
          props.state === "upcoming" && "border border-border",
        )}
      >
        {props.state === "done" ? (
          <SymbolView name="checkmark" size={13} tintColorClassName="accent-screen" />
        ) : (
          <Text
            textRole="label"
            className={cn(
              "font-t3-bold",
              props.state === "current" ? "text-primary-foreground" : "text-foreground-muted",
            )}
          >
            {props.number}
          </Text>
        )}
      </View>
      <View className="flex-1 gap-2">
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Text
              className={cn(
                "text-base",
                props.state === "upcoming"
                  ? "text-foreground-muted"
                  : "font-t3-medium text-foreground",
              )}
            >
              {props.title}
            </Text>
            {props.summary && props.state === "done" ? (
              <Text className="text-sm text-foreground-muted">{props.summary}</Text>
            ) : null}
          </View>
          {props.state === "done" ? props.action : null}
        </View>
        {props.children}
      </View>
    </View>
  );
}

function StepText(props: { readonly children: ReactNode }) {
  return <Text className="text-sm leading-normal text-foreground-muted">{props.children}</Text>;
}

function CodeBlock(props: { readonly children: string }) {
  return (
    <View className="rounded-xl bg-subtle px-3 py-2">
      <Text selectable className="font-mono text-xs leading-normal text-foreground">
        {props.children}
      </Text>
    </View>
  );
}
