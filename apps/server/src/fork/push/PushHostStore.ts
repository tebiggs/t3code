import {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

export const PushDevice = Schema.Struct({
  deviceId: Schema.String,
  userId: Schema.String,
  token: Schema.String,
  packageName: Schema.NullOr(Schema.String),
  label: Schema.String,
  preferences: RelayAgentAwarenessPreferences,
  registeredAt: Schema.String,
  lastAggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  lastSentAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type PushDevice = typeof PushDevice.Type;

export const PushPeer = Schema.Struct({
  environmentId: Schema.String,
  lastHeardAt: Schema.String,
});
export type PushPeer = typeof PushPeer.Type;

export const PushHostState = Schema.Struct({
  devices: Schema.Array(PushDevice),
  rows: Schema.Array(RelayAgentActivityState),
  peers: Schema.Array(PushPeer),
});
export type PushHostState = typeof PushHostState.Type;

const EMPTY_STATE: PushHostState = { devices: [], rows: [], peers: [] };

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(PushHostState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(PushHostState));

/**
 * The push host's devices, thread rows and peers, kept in one JSON file rather than a
 * migration, since a fork migration would collide with upstream's numbering.
 */
export class PushHostStore extends Context.Service<
  PushHostStore,
  {
    readonly load: Effect.Effect<PushHostState>;
    readonly save: (state: PushHostState) => Effect.Effect<void>;
  }
>()("t3/fork/push/PushHostStore") {}

const STORE_FILE_NAME = "fork-push-host.json";

export const layer = Layer.effect(
  PushHostStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const filePath = path.join(config.stateDir, STORE_FILE_NAME);
    return PushHostStore.of({
      load: fs.readFileString(filePath).pipe(
        Effect.map((contents) => Option.getOrElse(decodeState(contents), () => EMPTY_STATE)),
        Effect.orElseSucceed(() => EMPTY_STATE),
      ),
      save: Effect.fn("PushHostStore.save")(function* (state) {
        yield* encodeState(state).pipe(
          Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.catchCause((cause) =>
            Effect.logWarning("Push host state could not be saved", { filePath, cause }),
          ),
        );
      }),
    });
  }),
);

/** Keeps state in memory, for tests. */
export const layerMemory = (initial: PushHostState = EMPTY_STATE) =>
  Layer.effect(
    PushHostStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial);
      return PushHostStore.of({
        load: Ref.get(ref),
        save: Effect.fn("PushHostStore.saveInMemory")(function* (next) {
          yield* Ref.set(ref, next);
        }),
      });
    }),
  );
