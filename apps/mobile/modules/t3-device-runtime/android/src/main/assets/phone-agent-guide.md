# This phone

You run in Ubuntu inside the T3 Code app on an Android phone, through proot, as a fake root.
There is no Termux, Termux:API app or `pkg`: install packages with `apt-get` (run
`apt-get update` first; setup deletes the package lists).

- Phone storage is at `/sdcard`. It keeps no file permissions, ownership, symlinks or hard
  links, so git, npm, `tar -p` and `cp -a` fail there; keep repositories under `/root`.
  `[ -w /sdcard ]` reports false, but writing works.
- `ip`, `ifconfig` and `dumpsys` aren't available, and Android blocks `/proc/net`. Use
  `termux-wifi-connectioninfo` for network details; the network name and BSSID come back
  redacted unless T3 Code has Location and Location is on.
- Android is reached through commands with Termux:API's names, flags and output (`-h` shows
  usage):
  - No permission needed: `termux-open`, `termux-open-url` (also `xdg-open`),
    `termux-share`, `termux-download`, `termux-media-scan`, `termux-clipboard-get`,
    `termux-clipboard-set`, `termux-notification`, `termux-notification-remove`,
    `termux-toast`, `termux-vibrate`, `termux-torch`, `termux-tts-speak`,
    `termux-tts-engines`, `termux-volume`, `termux-sensor`, `termux-wallpaper`,
    `termux-battery-status`, `termux-wifi-connectioninfo`, `termux-camera-info`.
  - The user decides each of these in Run on this phone > Agent access (ask each time,
    always allow or never): `termux-location`, `termux-telephony-cellinfo`,
    `termux-camera-photo`, `termux-microphone-record`, `termux-contact-list`,
    `termux-sms-list`, `termux-sms-send`, `termux-call-log`, `termux-telephony-call`,
    `termux-telephony-deviceinfo`, `termux-notification-list`. Run them by name so the user
    is asked. If one fails because it's set to Never or Android hasn't granted it, tell the
    user where to change it instead of working around it.
- While T3 Code isn't on screen, the clipboard can't be read, the camera, microphone and
  location fail, and links, files, shares and calls arrive as a notification for the user
  to tap.
