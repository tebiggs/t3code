import { msg, T, useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

// Paths as the phone's Ubuntu sees them; the runtime binds phone storage at /sdcard.
const SHORTCUTS = [
  { label: msg("Phone storage"), path: "/sdcard/" },
  { label: msg("Downloads"), path: "/sdcard/Download/" },
  { label: msg("Documents"), path: "/sdcard/Documents/" },
  { label: msg("Ubuntu home"), path: "~/" },
] as const;

/** Folder shortcuts in Add project → Local folder for this phone's own environment. */
export function PhoneFolderShortcuts(props: { readonly onPick: (path: string) => void }) {
  const gt = useGT();
  const m = useMessages();
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        {SHORTCUTS.map((shortcut) => (
          <Pressable
            key={shortcut.path}
            accessibilityRole="button"
            accessibilityLabel={gt("Browse {folder}", { folder: m(shortcut.label) })}
            onPress={() => props.onPick(shortcut.path)}
            className="h-8 justify-center rounded-full bg-grouped-card px-3 active:opacity-70"
          >
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              {m(shortcut.label)}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text textRole="footnote" className="px-1 text-foreground-muted">
        <T>
          Phone storage keeps no file permissions or symlinks, so keep git repositories in Ubuntu
          home.
        </T>
      </Text>
    </View>
  );
}
