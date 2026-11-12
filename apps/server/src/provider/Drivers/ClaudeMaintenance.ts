import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceResolverServices,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { resolveClaudeHomePath } from "./ClaudeHome.ts";

const NATIVE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
const UpdateChannelSettings = fromLenientJson(
  Schema.Struct({ autoUpdatesChannel: Schema.optional(Schema.Literals(["latest", "stable"])) }),
);
const NativeVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/));
const APT_PACKAGE_FILES = "/var/lib/dpkg/info/claude-code.list";
const APT_SOURCES = "/etc/apt/sources.list.d";
const APT_SOURCE_CHANNEL = /downloads\.claude\.ai\/claude-code\/apt\/(latest|stable)\b/;
const APT_UPGRADE = "apt-get install -y --only-upgrade claude-code";

const update = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  mise: { tool: "claude" },
  nativeUpdate: {
    args: ["update"],
    // On Unix the native launcher links into ${XDG_DATA_HOME:-~/.local/share}/claude/versions; a
    // plain file at ~/.local/bin/claude is a wrapper whose owner `claude update` cannot see.
    isCommandPath: (commandPath) => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/.local/bin/claude.exe") ||
        normalized.includes("/.local/share/claude/") ||
        normalized.includes("/claude/versions/")
      );
    },
    requiresCommandPath: true,
  },
});

const readUpdateChannel = Effect.fn("ClaudeMaintenance.readUpdateChannel")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const managedDirectory =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform === "win32"
        ? path.join(environment.PROGRAMFILES || "C:\\Program Files", "ClaudeCode")
        : "/etc/claude-code";
  const dropInDirectory = path.join(managedDirectory, "managed-settings.d");
  const dropIns = yield* fs.readDirectory(dropInDirectory).pipe(Effect.orElseSucceed(() => []));
  // The updater inherits the server's config directory, not the instance's homePath.
  const configDirectory = yield* resolveClaudeHomePath({ homePath: "" }, environment);
  const settingsPaths = [
    path.join(configDirectory, "settings.json"),
    path.join(managedDirectory, "managed-settings.json"),
    ...dropIns
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .toSorted()
      .map((name) => path.join(dropInDirectory, name)),
  ];
  const channels = yield* Effect.forEach(settingsPaths, (settingsPath) =>
    fs.readFileString(settingsPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(UpdateChannelSettings)),
      Effect.map((settings) => settings.autoUpdatesChannel),
      Effect.orElseSucceed(() => undefined),
    ),
  );
  return channels.findLast((channel) => channel !== undefined) ?? "latest";
});

/** Anthropic's apt package refuses `claude update`, and its repository picks the channel. */
const readAptInstall = Effect.fn("ClaudeMaintenance.readAptInstall")(function* (
  executable: string,
) {
  if ((yield* HostProcess.Platform) !== "linux") return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageFiles = yield* fs
    .readFileString(APT_PACKAGE_FILES)
    .pipe(Effect.orElseSucceed(() => ""));
  if (!packageFiles.split("\n").includes(executable)) return null;
  const names = yield* fs.readDirectory(APT_SOURCES).pipe(Effect.orElseSucceed(() => []));
  for (const name of names.filter((name) => /^[\w.-]+$/.test(name)).toSorted()) {
    const sourceFile = path.join(APT_SOURCES, name);
    const source = yield* fs.readFileString(sourceFile).pipe(Effect.orElseSucceed(() => ""));
    const channel = APT_SOURCE_CHANNEL.exec(source)?.[1];
    if (channel === "latest" || channel === "stable") return { executable, sourceFile, channel };
  }
  return { executable, sourceFile: null, channel: "stable" as const };
});

const resolveClaudeMaintenance = Effect.fn("ClaudeMaintenance.resolve")(function* (
  capabilities: ProviderMaintenanceCapabilities,
) {
  const native = capabilities.update?.lockKey === "claudeAgent-native";
  // Apt's /usr/bin/claude is outside the native updater's paths, so it arrives manual-only.
  const executable = native
    ? capabilities.update?.executable
    : capabilities.update === null
      ? capabilities.installPath
      : undefined;
  if (executable === undefined) return capabilities;
  const apt = yield* readAptInstall(executable);
  if (apt === null && !native) return capabilities;
  const channel = apt?.channel ?? (yield* readUpdateChannel());
  const client = yield* HttpClient.HttpClient;
  const url = `${NATIVE_RELEASES}/${channel}`;
  const latest = {
    latestVersion: null,
    latestVersionCacheKey: url,
    lookupLatestVersion: client.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.map((text) => text.trim()),
      Effect.flatMap(Schema.decodeUnknownEffect(NativeVersion)),
      Effect.timeoutOption("4 seconds"),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    ),
  };
  if (apt === null) return { ...capabilities, ...latest };
  if ((yield* HostProcess.UserId) !== 0) {
    return {
      ...makeManualOnlyProviderMaintenanceCapabilities({
        provider: capabilities.provider,
        packageName: capabilities.packageName,
        installPath: apt.executable,
        manualCommand: `sudo apt-get update && sudo ${APT_UPGRADE}`,
      }),
      ...latest,
    };
  }
  // Only Claude's list, as Ubuntu's indexes take long to fetch and the phone deletes them.
  const refresh =
    apt.sourceFile === null
      ? "apt-get update"
      : `apt-get update -o Dir::Etc::SourceList=${apt.sourceFile} -o Dir::Etc::SourceParts=- -o APT::Get::List-Cleanup=0`;
  const script = `${refresh} && ${APT_UPGRADE}`;
  return {
    ...makeProviderMaintenanceCapabilities({
      provider: capabilities.provider,
      packageName: capabilities.packageName,
      updateExecutable: "/bin/sh",
      updateArgs: ["-c", script],
      updateLockKey: "claudeAgent-apt",
      updateCommand: script,
      env: { DEBIAN_FRONTEND: "noninteractive" },
    }),
    ...latest,
  };
});

export const makeClaudeMaintenanceResolution = Effect.fn("ClaudeMaintenance.make")(function* (
  options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
) {
  const services = yield* Effect.context<
    ProviderMaintenanceResolverServices | HttpClient.HttpClient
  >();
  const resolveInstallation = yield* makeCachedProviderMaintenanceResolution(
    resolveProviderMaintenanceCapabilitiesEffect(update, options).pipe(
      Effect.provideContext(services),
    ),
  );
  const resolve: typeof resolveInstallation = (refreshOptions) =>
    resolveInstallation(refreshOptions).pipe(
      Effect.flatMap(resolveClaudeMaintenance),
      Effect.provideContext(services),
    );
  return resolve;
});
