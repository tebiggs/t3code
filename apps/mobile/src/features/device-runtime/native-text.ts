import { decodeOptions, msg, useMessages } from "gt-react-native";
import { useEffect } from "react";

import { deviceRuntime } from "./device-runtime";

/** The English the device runtime's Kotlin passes to `localized()`, character for character. */
const NATIVE_TEXT: ReadonlyArray<string> = [
  // Install and update steps.
  msg("Downloading Ubuntu"),
  msg("Installing Ubuntu packages"),
  msg("Installing Node.js"),
  msg("Installing Claude Code"),
  msg("Installing T3 Code"),
  msg("Updating T3 Code"),
  msg("Updating Claude Code"),
  msg("Cleaning up"),
  msg("Starting…"),
  msg("{step} (step {number} of {count})…"),
  msg("Finishing…"),
  msg("{step} failed (exit {code})."),
  msg("Cancelled."),
  msg("Setup or an update is already running."),
  msg("Wait for setup to finish first."),
  msg("The on-device runtime isn't installed."),
  msg("Ubuntu on this phone is missing or damaged. Install it again."),
  // Server and sign-in.
  msg("The server is running on this phone."),
  msg("Stop server"),
  msg("The server didn't stop within {seconds} seconds."),
  msg("T3 Code didn't give a pairing link."),
  msg("Signing in to Claude…"),
  msg("Sign-in exited with status {code}."),
  msg("Couldn't reach Claude's servers ({reason}). Check the connection, then sign in again."),
  msg("T3 Code on this phone"),
  msg("Shown while T3 Code installs, signs in or runs its server on this phone."),
  // Agent access categories.
  msg("Location"),
  msg("Camera"),
  msg("Microphone"),
  msg("Contacts"),
  msg("Text messages"),
  msg("Call log"),
  msg("Phone calls and device info"),
  msg("Notifications"),
  msg("Other apps"),
  // Requests from agents.
  msg("Allow {access}?"),
  msg("Allow", { $context: "verb, confirm button" }),
  msg("Don't allow"),
  msg("An agent or another device using this phone's server asked for this."),
  msg("An agent wants to run {command}. Tap to answer."),
  msg("An agent on this phone wants {access}. Tap to answer Android's prompt."),
  msg("Allow notification access"),
  msg("An agent on this phone wants to read its notifications. Turn on T3 Code here."),
  msg("Share from an agent"),
  msg("Call from an agent"),
  msg("Open an app from an agent"),
  msg("Open a link from an agent"),
  msg("Open from an agent"),
  // The notification body for an `am start` that names no app, link or action.
  msg("this intent"),
  msg("Agent notifications"),
  msg("Notifications that agents on this phone post."),
  msg("Requests from agents"),
  msg("Links, shares and permissions that agents ask for while T3 Code isn't on screen."),
];

function english(message: string): string {
  const source = decodeOptions(message)?.$_source;
  return typeof source === "string" ? source : message;
}

/** Keeps each `{name}` for Kotlin to fill in. */
function placeholders(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/\{(\w+)\}/g)].map(([token, name]) => [name, token]));
}

/** Sends the device runtime its notification, dialog and error text in the app's language. */
export function useDeviceRuntimeText() {
  const resolve = useMessages();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android shows the module's notifications and dialogs from its own copy of the text
  useEffect(() => {
    deviceRuntime?.setText(
      Object.fromEntries(
        NATIVE_TEXT.map((message) => {
          const source = english(message);
          return [source, resolve(message, placeholders(source))];
        }),
      ),
    );
  }, [resolve]);
}
