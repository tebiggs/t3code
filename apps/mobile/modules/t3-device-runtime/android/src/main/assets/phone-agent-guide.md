# This phone

You run in Ubuntu inside the T3 Code app on an Android phone, through proot, as a fake root.
There is no Termux, Termux:API app or `pkg`: install packages with `apt-get` (run
`apt-get update` first; setup deletes the package lists).

- Phone storage is at `/sdcard`. It keeps no file permissions, ownership, symlinks or hard
  links, so git, npm, `tar -p` and `cp -a` fail there; keep repositories under `/root`.
  `[ -w /sdcard ]` reports false, but writing works.
- `ip`, `ifconfig` and `dumpsys` aren't available, and Android blocks `/proc/net`. Use
  `termux-wifi-connectioninfo` for network details. The network name and BSSID come back
  redacted unless Location is Always allow in Settings > Agent access (Ask each time isn't
  enough: this command never asks), Android has given T3 Code Location, and Location is on.
- Android is reached through commands with Termux:API's names, flags and output (`-h` shows
  usage):
  - No permission needed: `termux-open`, `termux-open-url` (also `xdg-open`),
    `termux-share`, `termux-download`, `termux-media-scan`, `termux-clipboard-get`,
    `termux-clipboard-set`, `termux-notification`, `termux-notification-remove`,
    `termux-toast`, `termux-vibrate`, `termux-torch`, `termux-tts-speak`,
    `termux-tts-engines`, `termux-volume`, `termux-sensor`, `termux-wallpaper`,
    `termux-battery-status`, `termux-wifi-connectioninfo`, `termux-camera-info`.
  - The user decides each of these in T3 Code's Settings > Agent access (ask each time,
    always allow or never): `termux-location`, `termux-telephony-cellinfo`,
    `termux-camera-photo`, `termux-microphone-record`, `termux-contact-list`,
    `termux-sms-list`, `termux-sms-send`, `termux-call-log`, `termux-telephony-call`,
    `termux-telephony-deviceinfo`, `termux-notification-list`. With Ask each time, each run
    waits up to a minute for the user to answer on the phone, and fails if nobody does. The
    first use also shows Android's own permission prompt. If one fails because it's set to
    Never, wasn't approved or Android wasn't allowed, pass on the place the error names
    instead of working around it.
- While T3 Code isn't on screen, the clipboard can't be read, the camera, microphone and
  location fail, and links, files, shares and calls arrive as a notification for the user
  to tap.
