import { describe, expect, it } from "vite-plus/test";

import {
  phoneServerPort,
  currentPhoneSetupStep,
  phoneInstallState,
  type PhoneScriptStatus,
  type PhoneSetupInput,
} from "./phone-setup";

const READY_STATUS: PhoneScriptStatus = {
  launcherVersion: 1,
  port: 3773,
  storage: true,
  serverRunning: true,
  install: null,
  installRunning: false,
  prootDistro: true,
  ubuntu: true,
  environmentId: "env-phone",
  claudeVersion: "2.1.310",
  claudeSignedIn: true,
  claudePlan: "max",
  t3Version: "0.1.3-nightly.20261025.3669",
  t3Build: "fork",
};

function input(overrides: Partial<PhoneSetupInput> = {}): PhoneSetupInput {
  return {
    termuxInstalled: true,
    permission: "granted",
    probe: { kind: "ok", status: READY_STATUS },
    connected: true,
    ...overrides,
  };
}

describe("currentPhoneSetupStep", () => {
  it("walks the steps in order", () => {
    expect(currentPhoneSetupStep(input({ termuxInstalled: false }))).toBe("termux");
    expect(currentPhoneSetupStep(input({ permission: "denied" }))).toBe("permission");
    expect(
      currentPhoneSetupStep(
        input({ probe: { kind: "ok", status: { ...READY_STATUS, t3Version: null } } }),
      ),
    ).toBe("install");
    expect(
      currentPhoneSetupStep(
        input({ probe: { kind: "ok", status: { ...READY_STATUS, claudeSignedIn: false } } }),
      ),
    ).toBe("signIn");
    expect(currentPhoneSetupStep(input({ connected: false }))).toBe("connect");
    expect(currentPhoneSetupStep(input())).toBe("ready");
  });

  it("keeps the user on the Termux opt-in until a status check round-trips", () => {
    for (const probe of [
      { kind: "none" },
      { kind: "timeout" },
      { kind: "refused", message: "allow-external-apps is not true" },
    ] as const) {
      expect(currentPhoneSetupStep(input({ probe }))).toBe("permission");
    }
  });

  it("goes back to sign-in when the Claude token is gone, even while connected", () => {
    expect(
      currentPhoneSetupStep(
        input({ probe: { kind: "ok", status: { ...READY_STATUS, claudeSignedIn: false } } }),
      ),
    ).toBe("signIn");
  });
});

describe("phoneInstallState", () => {
  it("treats a hand-made Ubuntu with Claude Code as a partial install", () => {
    expect(phoneInstallState({ ...READY_STATUS, t3Version: null, launcherVersion: null })).toEqual({
      kind: "partial",
    });
  });

  it("reports a live installer as running, so the app offers no second install", () => {
    expect(
      phoneInstallState({
        ...READY_STATUS,
        t3Version: null,
        installRunning: true,
        install: { status: "running", step: 3, total: 4, message: "Claude Code", running: true },
      }),
    ).toEqual({ kind: "running", step: 3, total: 4, message: "Claude Code" });
  });

  it("keeps a finishing installer running until it lets go of its lock", () => {
    expect(
      phoneInstallState({
        ...READY_STATUS,
        prootDistro: false,
        ubuntu: false,
        claudeVersion: null,
        t3Version: null,
        installRunning: true,
        install: { status: "done", step: 4, total: 4, message: "Done", running: true },
      }),
    ).toEqual({ kind: "running", step: 4, total: 4, message: "Finishing" });
  });

  it("reports an installer Android killed midway as stopped where it was", () => {
    expect(
      phoneInstallState({
        ...READY_STATUS,
        t3Version: null,
        installRunning: false,
        install: { status: "running", step: 2, total: 4, message: "Ubuntu", running: false },
      }),
    ).toEqual({
      kind: "failed",
      step: 2,
      total: 4,
      message: "Setup was interrupted during: Ubuntu",
    });
  });

  it("ignores an old failure once everything is installed", () => {
    expect(
      phoneInstallState({
        ...READY_STATUS,
        install: { status: "failed", step: 3, total: 4, message: "network", running: false },
      }),
    ).toEqual({ kind: "done" });
  });
});

describe("phoneServerPort", () => {
  it("finds the phone's own servers by their loopback address", () => {
    expect(phoneServerPort("http://127.0.0.1:3773/")).toBe(3773);
    expect(phoneServerPort("http://localhost:3774")).toBe(3774);
  });

  it("leaves other machines alone", () => {
    expect(phoneServerPort("http://192.168.1.153:3773/")).toBeNull();
    expect(phoneServerPort("https://relay.example.test/")).toBeNull();
    expect(phoneServerPort("http://127.0.0.1.example.test:3773/")).toBeNull();
  });
});
