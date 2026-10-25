// Builds an installable release APK in two Gradle runs so the build fits in 16 GB.
// When Metro's JS bundle task overlaps the parallel native compile, the build peaks
// above 16 GB and the bundler is OOM-killed; bundling first, alone, keeps it under.
//
// APP_VARIANT defaults to preview. ANDROID_ABIS defaults to arm64-v8a (phones).
// GRADLE_MAX_WORKERS defaults to 4: on an 8-core, 16 GB machine, 4 and 6 workers
// both took 8 minutes for assembleRelease and peaked at 13.9 and 14.1 GB, and the
// default (8) took 10.5 minutes at 15.5 GB.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const mobileDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const androidDir = NodePath.join(mobileDir, "android");
const env = {
  ...process.env,
  APP_VARIANT: process.env.APP_VARIANT ?? "preview",
  EXPO_NO_GIT_STATUS: "1",
};
const gradleArgs = [
  "--console=plain",
  `-PreactNativeArchitectures=${process.env.ANDROID_ABIS ?? "arm64-v8a"}`,
  `--max-workers=${process.env.GRADLE_MAX_WORKERS ?? "4"}`,
];

function run(command, args, cwd) {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("expo", ["prebuild", "--clean", "--platform", "android"], mobileDir);
run("./gradlew", ["createBundleReleaseJsAndAssets", ...gradleArgs], androidDir);
run("./gradlew", ["assembleRelease", ...gradleArgs], androidDir);
console.log(`Release APK: ${NodePath.join(androidDir, "app/build/outputs/apk/release")}`);
