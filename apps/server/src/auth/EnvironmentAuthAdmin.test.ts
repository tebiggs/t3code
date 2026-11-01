import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layerServerConfig = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-auth-control-plane-test-",
      }),
    ),
  );

const layerEnvironmentAuth = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

// Holds the session a credential exchange is about to issue, after the credential is spent.
const layerEnvironmentAuthHoldingIssue = (hold: {
  readonly reached: Deferred.Deferred<void>;
  readonly released: Deferred.Deferred<void>;
}) =>
  EnvironmentAuth.layerFromStores.pipe(
    Layer.provideMerge(PairingGrantStore.layer),
    Layer.provideMerge(
      Layer.effect(
        SessionStore.SessionStore,
        Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          return {
            ...sessions,
            issue: (input: Parameters<typeof sessions.issue>[0]) =>
              input?.subject === "exchanging"
                ? Deferred.succeed(hold.reached, undefined).pipe(
                    Effect.andThen(Deferred.await(hold.released)),
                    Effect.andThen(sessions.issue(input)),
                  )
                : sessions.issue(input),
          };
        }),
      ).pipe(Layer.provide(SessionStore.layer)),
    ),
    Layer.provideMerge(EnvironmentAuthPolicy.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig()),
  );

it.layer(NodeServices.layer)("EnvironmentAuth administrative operations", (it) => {
  it.effect("revoking other access ends sessions and unused links but keeps the caller", () =>
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const caller = yield* environmentAuth.issueSession({ label: "phone" });
      const other = yield* environmentAuth.issueSession({ label: "laptop" });
      const unused = yield* environmentAuth.createPairingLink({ label: "unused" });

      yield* environmentAuth.revokeOtherAccess(caller.sessionId);

      expect((yield* sessions.verify(caller.token)).sessionId).toBe(caller.sessionId);
      expect(yield* Effect.isFailure(sessions.verify(other.token))).toBe(true);
      expect(yield* environmentAuth.listPairingLinks()).toEqual([]);
      expect(
        yield* Effect.isFailure(
          environmentAuth.exchangeBootstrapCredentialForAccessToken(unused.credential, undefined, {
            deviceType: "unknown",
          }),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("a link created inside the grant lock can't outlive a revocation waiting on it", () =>
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const caller = yield* environmentAuth.issueSession({ label: "phone" });
      const other = yield* environmentAuth.issueSession({ label: "laptop" });
      expect(yield* environmentAuth.isSessionActive(other.sessionId)).toBe(true);
      const inLock = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const issuing = yield* environmentAuth
        .withGrantLock(
          Deferred.succeed(inLock, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(environmentAuth.createPairingLink({ label: "late" })),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inLock);
      const revocation = yield* environmentAuth
        .revokeOtherAccess(caller.sessionId)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(issuing);
      yield* Fiber.join(revocation);

      expect(yield* environmentAuth.listPairingLinks()).toEqual([]);
      expect(yield* environmentAuth.isSessionActive(other.sessionId)).toBe(false);
      expect(yield* environmentAuth.isSessionActive(caller.sessionId)).toBe(true);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("a credential already being exchanged can't outlive the revocation", () =>
    Effect.gen(function* () {
      const hold = {
        reached: yield* Deferred.make<void>(),
        released: yield* Deferred.make<void>(),
      };
      yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const caller = yield* environmentAuth.issueSession({ label: "phone" });
        const link = yield* environmentAuth.createPairingLink({ subject: "exchanging" });

        const exchange = yield* environmentAuth
          .exchangeBootstrapCredentialForAccessToken(link.credential, undefined, {
            deviceType: "unknown",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(hold.reached);
        const revocation = yield* environmentAuth
          .revokeOtherAccess(caller.sessionId)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(hold.released, undefined);
        const exchanged = yield* Fiber.join(exchange);
        yield* Fiber.join(revocation);

        expect(yield* Effect.isFailure(sessions.verify(exchanged.access_token))).toBe(true);
      }).pipe(Effect.provide(layerEnvironmentAuthHoldingIssue(hold)));
    }),
  );

  it.effect("creates, lists, and revokes client pairing links", () =>
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const created = yield* environmentAuth.createPairingLink({
        scopes: ["orchestration:read"],
        subject: "one-time-token",
        label: "CI phone",
      });
      const listedBeforeRevoke = yield* environmentAuth.listPairingLinks();
      const revoked = yield* environmentAuth.revokePairingLink(created.id);
      const listedAfterRevoke = yield* environmentAuth.listPairingLinks();

      expect(created.scopes).toEqual(["orchestration:read"]);
      expect(created.credential.length).toBeGreaterThan(0);
      expect(listedBeforeRevoke).toHaveLength(1);
      expect(listedBeforeRevoke[0]?.id).toBe(created.id);
      expect(listedBeforeRevoke[0]?.label).toBe("CI phone");
      expect(listedBeforeRevoke[0]).not.toHaveProperty("credential");
      expect(revoked).toBe(true);
      expect(listedAfterRevoke).toHaveLength(0);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("issues bearer access token sessions without exposing raw tokens", () =>
    Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessionCredentials = yield* SessionStore.SessionStore;

      const issued = yield* environmentAuth.issueSession({
        label: "deploy-bot",
      });
      const verified = yield* sessionCredentials.verify(issued.token);
      const listedBeforeRevoke = yield* environmentAuth.listSessions();
      const revoked = yield* environmentAuth.revokeSession(issued.sessionId);
      const listedAfterRevoke = yield* environmentAuth.listSessions();

      expect(issued.method).toBe("bearer-access-token");
      expect(issued.scopes).toEqual(AuthStandardClientScopes);
      expect(issued.client.deviceType).toBe("bot");
      expect(issued.client.label).toBe("deploy-bot");
      expect(verified.sessionId).toBe(issued.sessionId);
      expect(verified.scopes).toEqual(AuthStandardClientScopes);
      expect(verified.method).toBe("bearer-access-token");
      expect(listedBeforeRevoke).toHaveLength(1);
      expect(listedBeforeRevoke[0]?.sessionId).toBe(issued.sessionId);
      expect("token" in (listedBeforeRevoke[0] ?? {})).toBe(false);
      expect(revoked).toBe(true);
      expect(listedAfterRevoke).toHaveLength(0);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );
});
