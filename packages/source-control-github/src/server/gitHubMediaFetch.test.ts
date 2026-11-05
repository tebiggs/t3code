import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const signedIn = Layer.mock(GitHubCredentials.GitHubCredentials)({
  get: (host) =>
    Effect.succeed({
      host,
      token: Redacted.make("signed-in"),
      source: "gh" as const,
      fingerprint: "fingerprint",
    }),
});

const renderedBy = (
  rest: GitHubRest.GitHubRest["Service"]["rest"],
  credential: GitHubRest.GitHubRest["Service"]["credential"] = () =>
    Effect.succeed({ token: Redacted.make("signed-in"), fingerprint: "fingerprint" }),
) => Layer.mock(GitHubRest.GitHubRest)({ rest, credential });

const neverRendered = renderedBy(() => Effect.die("rendered markdown for media it did not need"));

const renderedHtml = (body: string) => ({
  status: 200,
  headers: {},
  body,
  truncated: false,
  invalidUtf8: false,
});

const ATTACHMENT_ID = "47b6c0b9-cc20-4b2f-a3f4-60a7150ad3b8";
const ATTACHMENT_URL = `https://github.com/user-attachments/assets/${ATTACHMENT_ID}`;
const SIGNED_LINK = `https://private-user-images.githubusercontent.com/1/2-${ATTACHMENT_ID}.png?jwt=signed`;

describe("GitHubMediaFetch", () => {
  it.effect("loads private media immediately after login with the GitHub credential", () => {
    let lookups = 0;
    const authorizations: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const request = {
        url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
        headers: {},
      };
      expect((yield* fetchMedia(request))?.status).toBe(404);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(lookups).toBe(3);
      expect(authorizations).toEqual([undefined, "Bearer signed-in", "Bearer signed-in"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) =>
              ++lookups === 1
                ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
                : Effect.succeed({
                    host,
                    token: Redacted.make("signed-in"),
                    source: "gh" as const,
                    fingerprint: "fingerprint",
                  }),
          }),
          neverRendered,
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: request.headers.authorization ? 200 : 404,
                headers: { "content-type": "image/png" },
              }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps the credential off the object store a redirect hands the media to", () => {
    const authorizations: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      // A public attachment redirects, so it never spends quota on a signed link.
      const response = yield* fetchMedia({
        url: "https://github.com/user-attachments/assets/1a1842fb",
        repository: "owner/repo",
        headers: { range: "bytes=0-1" },
      });
      expect(response?.status).toBe(200);
      expect(authorizations).toEqual([
        ["github.com", "Bearer signed-in"],
        ["objects.example.com", undefined],
      ]);
    }).pipe(
      Effect.provide(Layer.merge(signedIn, neverRendered)),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          authorizations.push([url.hostname, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              url.hostname === "github.com"
                ? new Response(null, {
                    status: 302,
                    headers: { location: "https://objects.example.com/signed" },
                  })
                : new Response(null, { status: 200 }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("loads a private attachment through the signed link GitHub renders for it", () => {
    const requests: Array<[string, string | undefined, string | undefined]> = [];
    const rendered: Array<[string | undefined, GitHubRest.GitHubRestInput]> = [];
    let account: string | null = "first";
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const request = {
        url: ATTACHMENT_URL,
        repository: "owner/private",
        headers: { range: "bytes=0-1" },
      };
      expect((yield* fetchMedia(request))?.status).toBe(206);
      // A video's range requests must not each spend quota on a new link.
      expect((yield* fetchMedia(request))?.status).toBe(206);
      // Nor may another account, or no account, reuse a link GitHub signed for this one.
      account = "second";
      expect((yield* fetchMedia(request))?.status).toBe(206);
      account = null;
      expect((yield* fetchMedia(request))?.status).toBe(404);
      const rendering = {
        host: "github.com",
        operation: "renderAttachmentLink",
        method: "POST",
        path: "markdown",
        body: { text: `![](${ATTACHMENT_URL})`, mode: "gfm", context: "owner/private" },
        allowReserve: true,
      };
      expect(rendered).toEqual([
        ["first", rendering],
        ["second", rendering],
      ]);
      expect(requests.slice(0, 2)).toEqual([
        ["github.com", "Bearer signed-in", "bytes=0-1"],
        ["private-user-images.githubusercontent.com", undefined, "bytes=0-1"],
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          signedIn,
          renderedBy(
            (input) =>
              Effect.gen(function* () {
                const pinned = yield* GitHubRequestPolicy.PinnedGitHubCredential;
                rendered.push([pinned?.credentialFingerprint, input]);
                return renderedHtml(
                  `<p><a href="${SIGNED_LINK}"><img src="${SIGNED_LINK}" alt=""></a></p>`,
                );
              }),
            (host) =>
              account === null
                ? Effect.fail(
                    new GitHubRequestPolicy.GitHubApiAuthenticationError({
                      host,
                      operation: "credential",
                    }),
                  )
                : Effect.succeed({ token: Redacted.make(account), fingerprint: account }),
          ),
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          requests.push([url.hostname, request.headers.authorization, request.headers.range]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: url.hostname === "github.com" ? 404 : 206 }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("answers 404 when GitHub gives no signed link for the attachment", () =>
    Effect.gen(function* () {
      for (const [repository, rendering] of [
        // GitHub leaves the URL unsigned for some repositories, such as ones the account only reads.
        ["owner/other", Effect.succeed(renderedHtml(`<img src="${ATTACHMENT_URL}" alt="">`))],
        // A link it did not sign, or to another file, must not be fetched.
        [
          "owner/other",
          Effect.succeed(renderedHtml(`<img src="https://example.com/${ATTACHMENT_ID}.png">`)),
        ],
        [
          "owner/other",
          Effect.succeed(
            renderedHtml(
              '<img src="https://private-user-images.githubusercontent.com/1/2-other.png?jwt=x">',
            ),
          ),
        ],
        [
          "owner/other",
          Effect.fail(
            new GitHubRequestPolicy.GitHubApiNotFoundError({
              host: "github.com",
              operation: "renderAttachmentLink",
            }),
          ),
        ],
      ] as const) {
        const hosts: Array<string> = [];
        const response = yield* Effect.gen(function* () {
          const fetchMedia = yield* GitHubMediaFetch.make;
          return yield* fetchMedia({ url: ATTACHMENT_URL, repository, headers: {} });
        }).pipe(
          Effect.provide(renderedBy(() => rendering)),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              hosts.push(new URL(request.url).hostname);
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
              );
            }),
          ),
        );
        expect(response?.status).toBe(404);
        expect(hosts).toEqual(["github.com"]);
      }
    }).pipe(Effect.provide(signedIn), Effect.scoped),
  );

  it.effect("spends nothing on a signed link without a repository to render it in", () =>
    Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia({ url: ATTACHMENT_URL, headers: {} });
      expect(response?.status).toBe(404);
    }).pipe(
      Effect.provide(Layer.merge(signedIn, neverRendered)),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
        ),
      ),
      Effect.scoped,
    ),
  );
});
