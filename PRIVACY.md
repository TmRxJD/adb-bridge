# Privacy Policy

**adb-bridge**

Last updated: 10 August 2026

adb-bridge is a local program you run on your own computer. It copies a game's
save file off your Android device and hands it to a website open in your
browser. This policy describes what it reads, what it stores, and the only
circumstances in which anything leaves your machine.

## The short version

The bridge does not have a server. It collects no analytics, sets no
identifiers, and phones nothing home. The only network traffic it makes on its
own is a version check against the public npm registry.

Save data leaves your computer only if you explicitly link an account for a game
that supports upload, and only to that game's own site.

## What it reads

- **Your game's save file**, copied from your device over ADB, or read from the
  local path a game's profile points at. Only for games you have enabled.
- **Device identifiers reported by ADB** — the serial and model of the device
  you connect to, so the bridge can tell your devices apart and label them.

Save files are copied to a temporary location and served to the local website.
The bridge does not modify anything on your device.

## What it stores on your computer

A single configuration file at `~/.local-adb-bridge/config.json`:

- which games you have enabled
- whether automatic connect, upload and update are on
- the last device you used
- any extra site origins you have allowed
- for a game whose uploader you have linked, the credential that game's site
  gave the bridge so it can upload on your behalf

That file stays on your computer. Delete it and the bridge forgets all of it.
Running `adb-bridge <game> --unlink` removes a stored credential.

## What is sent, and where

**To the website in your browser, over `127.0.0.1`.** The save bytes, the device
label, and the bridge's status. This is a loopback connection; it does not leave
your machine. Only origins in a game's allow-list may connect — the bridge
refuses other sites, and you can inspect or extend that list with
`adb-bridge origins list`.

**To a game's own site, only if you link an account.** When you link, and only
then, the bridge may upload your save data to that game's service so it can
process runs while the site is closed. You can turn this off at any time with
`--no-auto-upload`, or remove the link entirely with `--unlink`. What that site
then does with the data is covered by that site's own privacy policy.

**To the npm registry.** On start, the bridge asks
`registry.npmjs.org` for the latest published version so it can tell you about
or install an update. This request contains no personal data and can be disabled
with `--no-update`.

**To Google.** If you do not already have Android platform-tools, the bridge
offers to download the official package from `dl.google.com`. Only when you
accept, and only once.

## What is never sent

- The bridge has no telemetry, analytics or crash reporting.
- It does not read files belonging to games you have not enabled.
- It does not transmit your configuration file.
- Stored credentials are sent only to the site that issued them.

## Children

adb-bridge is a developer-style utility for players of specific games. It is not
directed at children and collects nothing about who is using it.

## Changes

Changes to this policy are committed to the repository, so the history is public
and diffable like the rest of the source.

## Contact

Open an issue at https://github.com/TmRxJD/adb-bridge/issues.
