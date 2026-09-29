# adb-bridge

A small local program that pulls a game's save file off your Android phone or
emulator over [ADB](https://developer.android.com/tools/adb) and hands it to a
website running in your browser.

**One bridge, many games.** Adding a second game does not install a second
bridge — it registers the game with the one you already have.

Licensed **GPL-3.0-or-later**. This software reads save files from your device
and your computer, so every line of it is source-available and stays that way:
anyone distributing a modified build must publish their changes.

---

## What it actually does

- Talks to your device with `adb`. If there is no working adb, it downloads
  Google's official platform-tools into `~/.local-adb-bridge` by itself -- no
  admin rights, no PATH changes, nothing to install by hand. An adb that exists
  but does not run is skipped rather than used.
- Copies the game's save file to a temp location and serves the bytes to a
  local website over a WebSocket on `127.0.0.1`.
- Optionally watches the save and re-sends it when the game writes.

## What it does not do

- It does not send anything anywhere except to the local port the site connects
  to, unless you explicitly link an account for a game that supports upload.
- It does not read files belonging to any game you have not enabled.
- It does not modify anything on your device. Pulls only.
- It does not require root on ordinary supported devices. If a cloud phone grants
  root only through `su` (including LDCloud), the bridge can use that read-only
  route when ADB connectivity is available.

## Install

```bash
npx adb-bridge
```

Or download an installer from
[Releases](https://github.com/TmRxJD/adb-bridge/releases).

### LDCloud

LDCloud normally runs beyond the local computer's ADB network, so the recommended
path is the Tower Run Tracker Android companion app installed inside the cloud
phone. In **LDCloud Assistant → ROOT Settings**, grant root to the tracker app,
then use **Import Save → LDCloud → Read current LDCloud save**. The app reads the
private save with `su` and passes it directly to the same decoder used by file and
ADB imports; it does not modify the game.

When an LDCloud instance exposes an ADB endpoint, this bridge also supports its
common configuration: unprivileged `adbd` plus per-app `su`. The bridge tries a
read-only `su -c cat` after normal app-storage access and before attempting to
restart `adbd` as root. Enter the exposed ADB port in the tracker import page.

For unattended transfers, the tracker import page can issue a scoped MacroDroid
or Tasker pairing token. For a no-network workflow, copy `playerInfo.dat` to
Download with a root file manager, export it through LDCloud Cloud Disk, and pick
the exported file on the import page.

### The tray

The **ADB Bridge** tray app runs the bridge in the background and starts with
Windows if you tick **Start with Windows**. Right-click the icon for:

- a status line per enabled game (signed-in account, last save read, last
  upload) — click it to open that game's site;
- per game: **Automatic uploads**, **Upload now**, and **Settings…**, which
  opens the settings the game's uploader plugin declares (for The Tower: which
  data to upload, and rules for which runs to skip — see
  [its README](plugins/uploader-thetower/README.md#settings));
- **Scan every** (how often the save is checked; an unchanged save is never
  pulled or uploaded again), **Show console**, **Help**, **Quit**.

If a bridge is already running, the tray controls it instead of starting a
second one. The same game settings are available on each game's website.

### Code signing

The Windows installer and executables are code signed. The free code signing
service is provided by [SignPath.io](https://signpath.io/), and the certificate
by the [SignPath Foundation](https://signpath.io/code-signing-for-open-source).

Signing happens in the release workflow, from a build produced by that workflow
out of this repository. Nothing is signed from a local machine.

### Versioning, and what each number means

Three numbers, and only one of them is a compatibility contract.

| | What it is | When it moves |
|---|---|---|
| `version` in package.json | The release number people see | Every release |
| `BRIDGE_PROTOCOL_VERSION` | What a website checks against | Only when the wire format changes in a way an older site cannot handle |
| shim `adb-bridge` range | Which releases reach an existing install | Only when the range would stop admitting new releases |

The website gates on the **protocol**, never on the release number. That is not
a style preference: the rename from `tracker-bridge` to `adb-bridge` reset the
release number from 1.x to 0.x, and the site's check was `version >= 1.4.0`, so
every working install read as too old -- including through the shim, which
reports the version of the adb-bridge it hands over to. A protocol number
survives renames and renumbering; a release number does not.

The shims track `>=0.2.2 <1.0.0` rather than `^0.2.2`. Below 1.0.0 npm treats a
minor bump as breaking, so `^0.2.2` would strand every shim install the moment
0.3.0 shipped. `npm run lint:version-reach` runs in `prepublishOnly` and fails
the publish if the version being released does not satisfy every shim's range.

Bumping the protocol is a two-step release, in this order: publish the bridge
that reports the new protocol, then raise `LOCAL_ADB_BRIDGE_MIN_PROTOCOL` on the
site. Doing it the other way locks out everyone who has not updated yet.

### Privacy

adb-bridge reads save files from your device and computer, so it is worth being
precise about where they go: see [PRIVACY.md](PRIVACY.md). In short, there is no
server, no telemetry, and save data leaves your computer only if you explicitly
link an account for a game that supports upload.

## Games

Run `adb-bridge` with nothing enabled (or `adb-bridge setup` any time) and it
asks which games to serve, then starts serving them.

```bash
adb-bridge setup
adb-bridge games list
adb-bridge games add thetower
adb-bridge games add cifi
adb-bridge games remove cifi
```

Each enabled game gets its own local port, so its website connects the same way
it always has. Running `add` when a bridge is already installed registers the
game with that bridge rather than creating a second one, and a running bridge
starts or stops the game within a few seconds -- no restart.

### Ports, restarts and updates

- **Already running?** Starting `adb-bridge` again while a current copy is
  serving just says so and exits; that copy keeps serving.
- **An older bridge on the port** (an old `cifi-bridge` / `tracker-bridge`, or an
  older adb-bridge) is stopped and replaced automatically. A process is only
  stopped when the OS reports it owns the port *and* its command line names a
  bridge; any other program on the port is reported, never touched.
- **Updates** are checked at start and every 6 hours, and applied by handing off
  to the newest release in the same window. `--no-auto-update` turns this off,
  `--no-update` skips it for one run.

### Adding a game yourself

Drop a JSON file in `~/.adb-bridge/games/`. Nothing to publish, no code:

```json
{
  "id": "mygame",
  "name": "My Game",
  "port": 43801,
  "androidPackages": ["com.example.mygame"],
  "saveFilename": "save.dat"
}
```

`adb-bridge games list` will pick it up. See
[`docs/game-profiles.md`](docs/game-profiles.md) for every field.

## Which sites may connect

The bridge serves save-file bytes off your device, so it only accepts
connections from the sites a game declares. Anything else is refused.

```bash
adb-bridge origins list
adb-bridge origins add thetower https://my-mirror.example
adb-bridge origins remove thetower https://my-mirror.example
```

Changes apply immediately — no restart. A game's own sites are built in and
cannot be removed here; to change those, put your own profile in
`~/.adb-bridge/games/`.

## Autostart

```bash
adb-bridge --boot          # register, then run
adb-bridge --boot-only     # register and exit (for installers)
adb-bridge --remove-boot
```

On Windows this creates a Scheduled Task, falling back to a hidden launcher script in
your Startup folder when the task cannot be created without administrator
rights. It never writes a `Run` registry key — that is hidden from users and is
one of the behaviours antivirus heuristics score as malware.

## Building from source

```bash
npm install
npm test
```
