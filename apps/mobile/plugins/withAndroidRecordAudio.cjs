const { withAndroidManifest } = require("expo/config-plugins");

const RECORD_AUDIO = "android.permission.RECORD_AUDIO";

// expo-image-picker's `microphonePermission: false` blocks RECORD_AUDIO for every package.
// termux-microphone-record in the on-device runtime needs it on Android, so the block is lifted
// there. Listed before expo-image-picker: manifest mods run last-registered first.
module.exports = function withAndroidRecordAudio(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults.manifest;
    manifest["uses-permission"] = (manifest["uses-permission"] ?? []).filter(
      (permission) =>
        permission.$?.["android:name"] !== RECORD_AUDIO ||
        permission.$?.["tools:node"] !== "remove",
    );
    return nextConfig;
  });
};
