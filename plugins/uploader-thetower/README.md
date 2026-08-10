# adb-bridge-uploader-thetower

Background run upload for **The Tower**, as an [adb-bridge](https://www.npmjs.com/package/adb-bridge)
uploader plugin.

With this installed and an account linked, new runs reach
[the-tower-run-tracker.com](https://the-tower-run-tracker.com) a few seconds
after the game writes its save — the website does not need to be open.

## Install

```bash
npm install -g adb-bridge adb-bridge-uploader-thetower
```

adb-bridge loads it automatically when The Tower is enabled. Without it, The
Tower still works as a save bridge; you just import from the website instead.

## Why it is a separate package

Uploading means parsing The Tower's save format and talking to its Appwrite
backend. That cannot be made game-agnostic, and putting it in adb-bridge would
install the Appwrite SDK and the whole tracker platform package for everyone —
including people who only play a different game.

## Linking an account

Link from the tracker website's import page. It hands the bridge its Appwrite
session, which is stored at:

```
~/.adb-bridge/uploaders/thetower/account.json
```

The session secret grants full account access, so that file is created `0600`
and, on Windows, has its ACL reset to your user with inherited entries removed.
It is never sent anywhere except the Appwrite endpoint it came from, and never
included in anything the bridge reports back to the website.

The site lists the session under **Linked devices** and can revoke it at any
time, which immediately invalidates whatever is stored here.

To forget it locally:

```bash
adb-bridge  # then use the website's Unlink button
```

or delete the file.

## Settings

`~/.adb-bridge/uploaders/thetower/config.json`

| Key | Default | Meaning |
|---|---|---|
| `autoUpload` | `false` | Upload new runs when the save changes. Opt-in. |
| `domains` | `["runs"]` | What may be uploaded. Everything beyond runs is opt-in. |

These are per-game on purpose: turning auto-upload on for The Tower does not
turn it on for any other game the bridge serves.

Licensed GPL-3.0-or-later.
