import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import { GITHUB_CREDENTIALED_MEDIA_HOSTS, gitHubAttachmentId } from "../shared/gitHubMedia.ts";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
 */
const isCredentialedHost = (url: string) => {
  try {
    return GITHUB_CREDENTIALED_MEDIA_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const SIGNED_ATTACHMENT_HOST = "private-user-images.githubusercontent.com";
const IMAGE_SOURCE_PATTERN = /<img\b[^>]*?\bsrc="([^"]+)"/u;
// GitHub signs these links for five minutes.
const SIGNED_LINK_CACHE_LIFETIME = "1 minute";

const signedAttachmentLink = (html: string, attachmentId: string) => {
  const source = IMAGE_SOURCE_PATTERN.exec(html)?.[1]?.replaceAll("&amp;", "&");
  if (source === undefined || !URL.canParse(source)) return null;
  const { protocol, hostname, pathname } = new URL(source);
  return protocol === "https:" &&
    hostname === SIGNED_ATTACHMENT_HOST &&
    pathname.includes(attachmentId)
    ? source
    : null;
};

export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const api = yield* GitHubRest.GitHubRest;

  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  // Read on every fetch, so media loads as soon as the user signs in.
  const token = Effect.suspend(() => credentials.get("github.com")).pipe(
    Effect.map((credential) => credential.token),
    Effect.orElseSucceed(() => null),
  );

  const follow = Effect.fnUntraced(function* (
    url: string,
    headers: SourceControlMediaRequest["headers"],
    bearer: Redacted.Redacted<string> | null,
  ) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const authorization =
        bearer !== null && isCredentialedHost(target) ? `Bearer ${Redacted.value(bearer)}` : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target).pipe(
            HttpClientRequest.setHeaders({
              ...headers,
              // The bytes are streamed straight through, so never let an encoding layer in.
              "accept-encoding": "identity",
              ...(authorization === null ? {} : { authorization }),
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return response;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "https:") return null;
      target = next.toString();
    }
  });

  // A private repository's attachment URL is a 404 to any token. Only GitHub's own rendering of it
  // says where the file is, as a short-lived signed link that needs no credential, so a link is
  // reused only under the credential GitHub signed it for.
  const signedLinks = yield* Cache.makeWith(
    Effect.fnUntraced(function* (key: {
      readonly fingerprint: string;
      readonly url: string;
      readonly attachmentId: string;
      readonly repository: string;
    }) {
      const rendered = yield* api.rest({
        host: "github.com",
        operation: "renderAttachmentLink",
        method: "POST",
        path: "markdown",
        body: { text: `![](${key.url})`, mode: "gfm", context: key.repository },
        allowReserve: true,
      });
      return signedAttachmentLink(rendered.body, key.attachmentId);
    }),
    {
      capacity: 256,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? SIGNED_LINK_CACHE_LIFETIME : 0,
    },
  );

  return Effect.fn("GitHubMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const bearer = yield* token;
    const response = yield* follow(request.url, request.headers, bearer);
    const attachmentId = gitHubAttachmentId(request.url);
    if (response?.status !== 404 || request.repository === undefined || attachmentId === null) {
      return response;
    }
    const signer = yield* api.credential("github.com").pipe(Effect.option);
    if (Option.isNone(signer)) return response;
    const { token: signerToken, fingerprint } = signer.value;
    const link = yield* Cache.get(signedLinks, {
      fingerprint,
      url: request.url,
      attachmentId,
      repository: request.repository,
    }).pipe(
      Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
        host: "github.com",
        token: signerToken,
        credentialFingerprint: fingerprint,
      }),
      Effect.orElseSucceed(() => null),
    );
    return link === null ? response : yield* follow(link, request.headers, bearer);
  });
});
