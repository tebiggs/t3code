export const PHONE_SCRIPT_VERSION = 1;

/** What the installer last recorded in ~/.t3-phone/install.state. */
export interface PhoneInstallProgress {
  readonly status: "running" | "failed" | "done";
  readonly step: number;
  readonly total: number;
  readonly message: string;
  /** False with status "running" means Android killed the installer midway. */
  readonly running: boolean;
}

/** What `t3-phone status` found inside Termux. */
export interface PhoneScriptStatus {
  /** Version of the saved $PREFIX/bin/t3-phone, or null when setup never saved one. */
  readonly launcherVersion: number | null;
  readonly port: number;
  readonly storage: boolean;
  readonly serverRunning: boolean;
  readonly install: PhoneInstallProgress | null;
  readonly installRunning: boolean;
  readonly prootDistro: boolean;
  readonly ubuntu: boolean;
  /** The phone server's environment id, once it has started at least once. */
  readonly environmentId: string | null;
  readonly claudeVersion: string | null;
  readonly claudeSignedIn: boolean;
  readonly claudePlan: string | null;
  readonly t3Version: string | null;
  /** Upstream's when this fork had no server build for the phone at install time. */
  readonly t3Build: "fork" | "upstream" | null;
}

const DEFAULT_PORT = 3773;

function readKeyValues(stdout: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

function integer(value: string | undefined): number | null {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readInstallProgress(values: ReadonlyMap<string, string>): PhoneInstallProgress | null {
  const status = values.get("install_status");
  if (status !== "running" && status !== "failed" && status !== "done") return null;
  return {
    status,
    step: integer(values.get("install_step")) ?? 0,
    total: integer(values.get("install_total")) ?? 0,
    message: values.get("install_message") ?? "",
    running: values.get("install_running") === "true",
  };
}

function readBuild(value: string | undefined): PhoneScriptStatus["t3Build"] {
  return value === "fork" || value === "upstream" ? value : null;
}

export function parsePhoneScriptStatus(stdout: string): PhoneScriptStatus {
  const values = readKeyValues(stdout);
  return {
    launcherVersion: integer(values.get("launcher")),
    port: integer(values.get("port")) ?? DEFAULT_PORT,
    storage: values.get("storage") === "true",
    serverRunning: values.get("server") === "true",
    install: readInstallProgress(values),
    installRunning: values.get("install_running") === "true",
    prootDistro: values.get("proot") === "true",
    ubuntu: values.get("ubuntu") === "true",
    environmentId: nonEmpty(values.get("environment_id")),
    claudeVersion: nonEmpty(values.get("claude_version")),
    claudeSignedIn: values.get("claude_signed_in") === "true",
    claudePlan: nonEmpty(values.get("claude_plan")),
    t3Version: nonEmpty(values.get("t3_version")),
    t3Build: readBuild(values.get("t3_build")),
  };
}

export const UPSTREAM_SERVER_WARNING =
  "This phone runs upstream's T3 Code server because this app's releases had none for it. Update T3 Code to switch. If this stays after updating, the fork's Linux server build is failing.";

export function readPairingUrl(stdout: string): string | null {
  return nonEmpty(readKeyValues(stdout).get("pairing_url"));
}

export type PhoneSetupStepId = "termux" | "permission" | "install" | "signIn" | "connect";
export const PHONE_SETUP_STEPS: ReadonlyArray<PhoneSetupStepId> = [
  "termux",
  "permission",
  "install",
  "signIn",
  "connect",
];

/** The last `t3-phone status` round trip through Termux. */
export type PhoneProbe =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly status: PhoneScriptStatus }
  /** Termux answered with its own error, usually allow-external-apps being off. */
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed"; readonly message: string };

export interface PhoneSetupInput {
  readonly termuxInstalled: boolean;
  readonly permission: "granted" | "denied" | "blocked";
  readonly probe: PhoneProbe;
  /** The phone environment is saved in the app and connected. */
  readonly connected: boolean;
}

export type PhoneInstallState =
  | { readonly kind: "fresh" }
  /** Some parts are already there, for example a hand-made Ubuntu with Claude Code. */
  | { readonly kind: "partial" }
  | {
      readonly kind: "running";
      readonly step: number;
      readonly total: number;
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly step: number;
      readonly total: number;
      readonly message: string;
    }
  | { readonly kind: "done" };

export function phoneInstallState(status: PhoneScriptStatus): PhoneInstallState {
  const progress = status.install;
  // While the installer holds its lock, status skips Ubuntu, so its progress is all there is.
  if (status.installRunning) {
    return {
      kind: "running",
      step: progress?.step ?? 0,
      total: progress?.total ?? 0,
      message: progress?.status === "running" ? progress.message : "Finishing",
    };
  }
  const complete =
    status.prootDistro &&
    status.ubuntu &&
    status.claudeVersion !== null &&
    status.t3Version !== null &&
    status.launcherVersion !== null;
  if (complete) return { kind: "done" };
  // A "running" record with no live installer means Android killed it midway.
  if (progress?.status === "failed" || progress?.status === "running") {
    return {
      kind: "failed",
      step: progress.step,
      total: progress.total,
      message:
        progress.status === "running"
          ? `Setup was interrupted during: ${progress.message}`
          : progress.message,
    };
  }
  return status.prootDistro || status.ubuntu ? { kind: "partial" } : { kind: "fresh" };
}

/** The first step that isn't done yet, or "ready". */
export function currentPhoneSetupStep(input: PhoneSetupInput): PhoneSetupStepId | "ready" {
  if (!input.termuxInstalled) return "termux";
  if (input.permission !== "granted" || input.probe.kind !== "ok") return "permission";
  const status = input.probe.status;
  if (phoneInstallState(status).kind !== "done") return "install";
  if (!status.claudeSignedIn) return "signIn";
  if (!input.connected) return "connect";
  return "ready";
}

const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/;

/** The port of a server on this phone's loopback, or null for any other environment. */
export function phoneServerPort(displayUrl: string): number | null {
  const match = LOOPBACK_URL.exec(displayUrl.trim());
  return match ? Number(match[1]) : null;
}
