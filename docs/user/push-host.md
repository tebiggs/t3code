# Push host

This fork's Android app uses its own Firebase project, so T3 Connect's relay cannot send it notifications. Instead, one of your own T3 Code servers, the push host, sends them for itself and for the environments linked to it. Nothing passes through T3 Connect's relay.

## Set up the push host

1. Create a service account for your Firebase project with permission to send Cloud Messaging, and download its JSON key.
2. Pick an always-on server as the push host. Start it with `T3CODE_FCM_SERVICE_ACCOUNT_FILE` set to the key's path. Its log then says `Push host is on`. Anyone who can read the key can send notifications to your app, so keep it readable only by the server's user.
3. Open the Android app, connect to that environment, and allow notifications. **Settings → Notifications → Push host** shows the push host and says when this phone gets its notifications.

**Send a test notification** checks the whole path to this phone. **Stop notifications on this phone** unregisters it from the push host until you turn notifications back on there.

## Add your other environments

An environment sends its agent activity to the push host through a link to it. On that environment, turn on **Settings → Labs → Linked environments**, turn it on for the push host too, then link the push host from **Settings → Environments → Linked environments**. Read-only access is enough. Pick the push host from the list rather than typing an address: the list includes its T3 Connect address, which keeps working when the environment is away from your network, such as a server on your phone running on mobile data.

Each environment finds the push host among its links within a few minutes. The push host's section in **Settings → Notifications** shows each connected environment, whether it sends to the push host, and when its link expires.

Links last 30 days. When one expires, that environment stops sending until you link it again with a new pairing code. Turning **Linked environments** off later does not stop sending over an existing link.

## Publish agent activity

An environment sends to the push host unless **Publish agent activity** is turned off there, in its T3 Connect settings or with `t3 connect publish --disable`. An environment that has never been linked to T3 Connect sends. The push host's section shows when this setting is off.

## Removing the push host

Restart the push host without `T3CODE_FCM_SERVICE_ACCOUNT_FILE` to stop sending. Your other environments then go back to publishing through T3 Connect if they are linked to it. The push host keeps its list of registered phones, so adding the key back resumes notifications.
