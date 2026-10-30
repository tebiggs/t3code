import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import type { PhoneSharingRecord } from "../../persistence/mobile-preferences";
import { PHONE_STILL_LISTED, type PhoneSharing } from "./phone-sharing";
import { createPhoneSharingController } from "./phone-sharing-controller";

const environmentId = EnvironmentId.make("phone");
const connection = {
  environmentId,
  environmentLabel: "Phone",
  pairingUrl: "http://127.0.0.1:3774/",
  displayUrl: "http://127.0.0.1:3774/",
  httpBaseUrl: "http://127.0.0.1:3774/",
  wsBaseUrl: "ws://127.0.0.1:3774/",
  bearerToken: "local-bearer",
};
const shared = (cloudUserId: string | null): PhoneSharing => ({
  shared: true,
  revoked: false,
  cloudUserId,
  reachability: null,
});
const on: PhoneSharingRecord = { environmentId, accountId: "user_a", phase: "on" };

function setup(initial: PhoneSharingRecord | null = null, hydrated = async () => {}) {
  const state = {
    record: initial,
    account: "user_a" as string | null,
    connected: true,
    sharing: { shared: false } as PhoneSharing | null,
    stopFailure: null as string | null,
    deregisterFailure: null as string | null,
    saveFailure: null as string | null,
  };
  const stopOnServer = vi.fn(async () => {
    if (state.stopFailure === null) state.sharing = { shared: false };
    return state.stopFailure;
  });
  const deregister = vi.fn(async () => state.deregisterFailure);
  const loadRecord = vi.fn(() => state.record);
  const controller = createPhoneSharingController({
    hydrated,
    loadRecord,
    saveRecord: async (record) => {
      if (state.saveFailure !== null) throw new Error(state.saveFailure);
      state.record = record;
    },
    phoneEnvironmentId: () => environmentId,
    connectionFor: () => (state.connected ? connection : null),
    signedInAccount: () => state.account,
    readSharing: async () => (state.connected ? state.sharing : null),
    ensureRelayClient: async () => null,
    stopOnServer,
    deregister,
  });
  return { state, controller, stopOnServer, deregister, loadRecord };
}

describe("createPhoneSharingController", () => {
  it("undoes a share when the account signs out while it's linking", async () => {
    const { state, controller, stopOnServer } = setup();
    let finishLink = (_failure: string | null) => {};
    const sharing = controller.share(
      connection,
      "user_a",
      () =>
        new Promise((resolve) => {
          finishLink = resolve;
        }),
    );
    await vi.waitFor(() => expect(state.record?.phase).toBe("on"));
    state.account = null;
    const stopped = controller.stop();
    state.sharing = shared("user_a");
    finishLink(null);

    expect(await sharing).toContain("signed out");
    await stopped;
    expect(stopOnServer).toHaveBeenCalled();
    expect(state.sharing).toEqual({ shared: false });
  });

  it("keeps Off open until signing out other clients succeeds", async () => {
    const { state, controller, stopOnServer, deregister } = setup(on);
    state.sharing = shared("user_a");
    state.stopFailure = "other devices couldn't be signed out";

    expect(await controller.stop()).toBe("other devices couldn't be signed out");
    expect(state.record?.phase).toBe("stopping");
    expect(deregister).not.toHaveBeenCalled();

    // The server now reads as off, which must not end the retry.
    state.sharing = { shared: false };
    state.stopFailure = null;
    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).toHaveBeenCalledTimes(2);
    expect(deregister).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("refuses a new share while a stop is unfinished, keeping its record", async () => {
    const stopping: PhoneSharingRecord = { ...on, phase: "stopping" };
    const { state, controller } = setup(stopping);
    state.stopFailure = "other devices couldn't be signed out";
    const link = vi.fn(async () => null);

    expect(await controller.share(connection, "user_a", link)).toBe(state.stopFailure);
    expect(link).not.toHaveBeenCalled();
    expect(state.record).toEqual(stopping);
  });

  it("won't link over a share that's already on, or when it can't tell", async () => {
    const { state, controller } = setup();
    const link = vi.fn(async () => null);

    state.sharing = shared("user_b");
    expect(await controller.share(connection, "user_a", link)).toContain("already shared");
    state.sharing = null;
    expect(await controller.share(connection, "user_a", link)).toContain("Couldn't check");
    expect(link).not.toHaveBeenCalled();
    expect(state.record).toBeNull();
  });

  it("finishes a sign-out's stop once the server answers, leaving the listing for the account", async () => {
    const { state, controller, stopOnServer, deregister } = setup(on);
    state.account = null;
    state.connected = false;

    await controller.stop();
    expect(state.record?.phase).toBe("stopping");
    expect(stopOnServer).not.toHaveBeenCalled();

    state.connected = true;
    expect(await controller.reconcile()).toBe(PHONE_STILL_LISTED);
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(state.record?.phase).toBe("listed");
    expect(deregister).not.toHaveBeenCalled();

    state.account = "user_a";
    expect(await controller.reconcile()).toBeNull();
    expect(deregister).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("stops a share it has no record of, and never deregisters under another account", async () => {
    const { state, controller, deregister, stopOnServer } = setup();
    state.sharing = shared("user_b");
    expect(await controller.stop()).toBe(PHONE_STILL_LISTED);
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(deregister).not.toHaveBeenCalled();
    expect(state.record).toEqual({ environmentId, accountId: "user_b", phase: "listed" });
  });

  it("treats an unreadable server with no record as a stop still owed", async () => {
    const { state, controller, stopOnServer } = setup();
    state.connected = false;
    expect(await controller.stop()).not.toBeNull();
    expect(state.record).toEqual({ environmentId, accountId: null, phase: "stopping" });

    state.connected = true;
    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("leaves a confirmed-off phone with no record alone", async () => {
    const { state, controller, stopOnServer } = setup();
    expect(await controller.stop()).toBeNull();
    expect(stopOnServer).not.toHaveBeenCalled();
    expect(state.record).toBeNull();
  });

  it("rolls a failed share back in full, and keeps the listing until it's really gone", async () => {
    const { state, controller, stopOnServer, deregister } = setup();
    state.deregisterFailure = "relay down";
    expect(await controller.share(connection, "user_a", async () => "over the limit")).toBe(
      "over the limit",
    );
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(state.record?.phase).toBe("listed");

    state.deregisterFailure = null;
    expect(await controller.reconcile()).toBeNull();
    expect(deregister).toHaveBeenCalledTimes(2);
    expect(state.record).toBeNull();
  });

  it("ends a share a killed app left half set up", async () => {
    const { state, controller, stopOnServer } = setup(on);
    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("ends a share still open to an account this app has left", async () => {
    const { state, controller, stopOnServer, deregister } = setup(on);
    state.sharing = shared("user_a");
    state.account = "user_b";
    expect(await controller.reconcile()).toBe(PHONE_STILL_LISTED);
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(deregister).not.toHaveBeenCalled();
    expect(state.record?.phase).toBe("listed");
  });

  it("leaves a healthy share alone, including before the account is known", async () => {
    const { state, controller, stopOnServer } = setup(on);
    state.sharing = shared("user_a");
    expect(await controller.reconcile()).toBeNull();
    state.account = null;
    state.sharing = null;
    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).not.toHaveBeenCalled();
    expect(state.record).toEqual(on);
  });

  it("removes the listing when Ubuntu goes, even with the server down", async () => {
    const { state, controller, deregister } = setup(on);
    state.connected = false;
    expect(await controller.release()).toBeNull();
    expect(deregister).toHaveBeenCalledOnce();
    expect(state.record).toBeNull();
  });

  it("keeps the listing's record through a release while signed out", async () => {
    const { state, controller } = setup(on);
    state.connected = false;
    state.account = null;
    expect(await controller.release()).toBe(PHONE_STILL_LISTED);
    expect(state.record?.phase).toBe("listed");
  });

  it("won't let a connection be forgotten while its tunnel can't be stopped", async () => {
    const { state, controller } = setup(on);
    state.stopFailure = "unreachable";
    expect(await controller.stopBeforeForgetting()).toBe("unreachable");
    state.stopFailure = null;
    expect(await controller.stopBeforeForgetting()).toBeNull();
  });

  it("reports a record it couldn't save, and later tasks still run", async () => {
    const { state, controller } = setup(on);
    state.saveFailure = "storage full";
    expect(await controller.stop()).toBe("storage full");
    state.saveFailure = null;
    expect(await controller.stop()).toBeNull();
    expect(state.record).toBeNull();
  });

  it("keeps a sign-out's stop when saved preferences can't load, and honours it later", async () => {
    let loaded = false;
    const { state, controller, stopOnServer } = setup(null, async () => {
      if (!loaded) throw new Error("storage busy");
    });
    state.account = null;

    // The share only shows up once the record can be read.
    expect(await controller.stop()).toBe("storage busy");
    expect(stopOnServer).not.toHaveBeenCalled();

    loaded = true;
    state.record = on;
    state.sharing = shared("user_a");
    expect(await controller.reconcile()).toBe(PHONE_STILL_LISTED);
    expect(stopOnServer).toHaveBeenCalledOnce();
    expect(state.record?.phase).toBe("listed");
  });

  it("settles an owed stop before a new share, so it can't end that share later", async () => {
    const { state, controller, stopOnServer } = setup();
    state.connected = false;
    state.saveFailure = "storage busy";
    expect(await controller.stop()).toBe("storage busy");

    state.connected = true;
    state.saveFailure = null;
    const link = vi.fn(async () => {
      state.sharing = shared("user_a");
      return null;
    });
    expect(await controller.share(connection, "user_a", link)).toBeNull();
    expect(link).toHaveBeenCalledOnce();
    expect(stopOnServer).not.toHaveBeenCalled();

    expect(await controller.reconcile()).toBeNull();
    expect(stopOnServer).not.toHaveBeenCalled();
    expect(state.record?.phase).toBe("on");
  });

  it("reads and does nothing until saved preferences are loaded", async () => {
    let hydrate = () => {};
    let entered = () => {};
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hydrated = () =>
      new Promise<void>((resolve) => {
        hydrate = resolve;
        entered();
      });
    const { state, controller, stopOnServer, loadRecord } = setup(null, hydrated);
    state.sharing = shared("user_a");

    const stopped = controller.stop();
    await entering;
    expect(loadRecord).not.toHaveBeenCalled();
    expect(stopOnServer).not.toHaveBeenCalled();

    state.record = on;
    hydrate();
    await stopped;
    expect(stopOnServer).toHaveBeenCalledOnce();
  });
});
