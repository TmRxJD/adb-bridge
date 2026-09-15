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

Change them from the ADB Bridge tray (**The Tower → Settings…**) or the
tracker's import page (the cog next to the bridge). Both draw the same form,
which this plugin declares. They are stored in
`~/.adb-bridge/uploaders/thetower/config.json`.

**Upload these** — which data the bridge sends: battle reports, workshop, labs,
ultimate weapons, modules, cards, vault, bots, guardians, relics, lifetime. All
on by default; a data type added in a later release starts on.

**Skip farming runs that…** — each rule is off until you tick it:

- ended before wave *N*
- were played outside tier *A* to *B* (leave one side empty for no bound)
- earned coins more than *X*% from your median for that tier. The median comes
  from the save's own farming runs at that tier; with fewer than 5 of them
  there is no median yet, and those runs upload.

**Tournament runs** — tournament runs are recognised from the save and never
face the farming rules (a league is not a tier):

- *Keep only the highest wave of each tournament.* Tournaments start every
  Wednesday and Saturday at 00:00 UTC; a run belongs to the latest start before
  it. Only the best run per tournament uploads. If the new best beats a run
  already in your tracker, that run is replaced: it is hidden (soft-deleted)
  after the better one is written, never before. An equal wave keeps the run you
  already have. Only tournaments the save has a new run for are touched.
- *Skip runs that ended before wave N.*

Every upload reports how many runs were sent, skipped by your rules, already
uploaded, and replaced — in the tray console and the import page.

| Key | Default | Meaning |
|---|---|---|
| `autoUpload` | `false` | Upload when the save changes. Linking from the site turns it on. |

These are per-game on purpose: turning auto-upload on for The Tower does not
turn it on for any other game the bridge serves.

Needs adb-bridge 0.5.0 or later, which draws the rule sections. Filters saved
by plugin 0.3.x are carried over to the farming rules.

Licensed GPL-3.0-or-later.
