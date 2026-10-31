import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  cliReleaseIndexPageUrl,
  cliReleaseTagApiUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";

export interface NpmRelease {
  readonly version: string;
  /** Absent on releases published before npm manifests carried it. */
  readonly databaseMigration: number | undefined;
}

const decodeReleaseIndex = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ tag_name: Schema.String })),
);

/** `spec` is an exact version or a dist-tag such as `nightly`. Null when no such release exists.
 * Refreshes only while mounted; the published check below keeps its own versions alive.
 * Fork (FORK.md): reads this fork's GitHub releases, which npm never has. They carry no manifest,
 * so `databaseMigration` stays undefined and a track crossing stays blocked. */
export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make(
    Effect.gen(function* () {
      const channel = spec === "latest" ? "stable" : spec === "nightly" ? "nightly" : null;
      const response = yield* HttpClient.get(
        channel === null ? cliReleaseTagApiUrl(spec) : cliReleaseIndexPageUrl(1),
      );
      if (response.status === 404) return null;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      const version =
        channel === null
          ? typeof body === "object" &&
            body !== null &&
            "tag_name" in body &&
            body.tag_name === `v${spec}`
            ? spec
            : undefined
          : newestCliReleaseVersion(yield* decodeReleaseIndex(body), channel);
      if (version === undefined) return null;
      return { version, databaseMigration: undefined } satisfies NpmRelease;
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight for every check.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(Atom.withRefresh("5 minutes"), Atom.withLabel(`npm-release:${spec}`)),
);

export const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make((get) =>
    get.result(npmReleaseAtom(version)).pipe(Effect.map((release) => release?.version === version)),
  ).pipe(Atom.keepAlive, Atom.withLabel(`npm-release-published:${version}`)),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("npm-release-published:none"),
);

export function useNpmReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? npmReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
