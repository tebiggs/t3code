import type { PhoneServerHostKind } from "../../persistence/mobile-preferences";
import { readPairingUrl } from "./phone-setup";
import {
  getTermuxStatus,
  runPhoneScript,
  startPhoneScriptInBackground,
  stopPhoneServer,
  termuxErrorMessage,
} from "./termux";

const SCRIPT_TIMEOUT_MS = 60_000;
// Downloads a ~90 MB server archive over the phone's connection.
const UPDATE_TIMEOUT_MS = 20 * 60_000;

/** Whatever runs this phone's T3 server: Termux, or the Ubuntu runtime inside this app. */
export interface PhoneServerHost {
  readonly kind: PhoneServerHostKind;
  /** Where the server runs, for messages: "in Termux". */
  readonly where: string;
  /** Why the server can't start right now, or null when it can. */
  unavailable(): string | null;
  /** Starts the server in the background; callers wait for its port to answer. */
  launch(port: number): void;
  stop(): Promise<void>;
  /** Mints a pairing token on the server's machine. */
  pairingUrl(): Promise<string>;
  /** Installs the newest server build (and, in this app's runtime, Claude Code). */
  update(): Promise<void>;
  logTail(): Promise<string>;
  /** Where to find the full log, for when its tail isn't available. */
  readonly logLocation: string;
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_TERMUX_TIMEOUT"
  );
}

export const termuxHost: PhoneServerHost = {
  kind: "termux",
  where: "in Termux",
  logLocation: "~/.t3-phone/server.log in Termux",
  unavailable() {
    const termux = getTermuxStatus();
    if (!termux.installed) return "Termux isn't installed anymore.";
    if (!termux.permissionGranted)
      return "T3 Code isn't allowed to run commands in Termux anymore.";
    return null;
  },
  launch() {
    startPhoneScriptInBackground(["serve"]);
  },
  stop: stopPhoneServer,
  async pairingUrl() {
    const result = await runPhoneScript(["pair"], SCRIPT_TIMEOUT_MS);
    const refused = termuxErrorMessage(result);
    const url = refused === null ? readPairingUrl(result.stdout) : null;
    if (url === null) {
      throw new Error(refused ?? (result.stderr.trim() || "T3 Code didn't give a pairing link."));
    }
    return url;
  },
  async update() {
    const result = await runPhoneScript(["update"], UPDATE_TIMEOUT_MS).catch((error: unknown) => {
      if (!isTimeout(error)) throw error;
      // The installer keeps going in Termux; a later Update restarts on whatever it installed.
      throw new Error(
        "The update is still downloading in Termux. Tap Update again in a few minutes.",
      );
    });
    const refused = termuxErrorMessage(result);
    if (refused !== null) throw new Error(refused);
    if (result.exitCode !== 0) {
      const output = (result.stderr.trim() || result.stdout.trim())
        .split("\n")
        .slice(-5)
        .join("\n");
      throw new Error(output || "The update didn't finish.");
    }
  },
  async logTail() {
    try {
      const result = await runPhoneScript(["log", "15"], SCRIPT_TIMEOUT_MS);
      return termuxErrorMessage(result) === null ? result.stdout.trim() : "";
    } catch {
      return "";
    }
  },
};
