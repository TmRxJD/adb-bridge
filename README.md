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

- Talks to your device with `adb`, installing Google's official platform-tools
  if you don't have them.
- Copies the game's save file to a temp location and serves the bytes to a
  local website over a WebSocket on `127.0.0.1`.
- Optionally watches the save and re-sends it when the game writes.

## What it does not do

- It does not send anything anywhere except to the local port the site connects
  to, unless you explicitly link an account for a game that supports upload.
- It does not read files belonging to any game you have not enabled.
- It does not modify anything on your device. Pulls only.
- It does not require root.

## Install

```bash
npx adb-bridge
```

Or download an installer from
[Releases](https://github.com/TmRxJD/adb-bridge/releases).

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

```bash
adb-bridge games list
adb-bridge games add thetower
adb-bridge games add cifi
adb-bridge games remove cifi
```

Each enabled game gets its own local port, so its website connects the same way
it always has. Running `add` when a bridge is already installed registers the
game with that bridge rather than creating a second one.

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

On Windows this creates a Scheduled Task, falling back to a visible script in
your Startup folder when the task cannot be created without administrator
rights. It never writes a `Run` registry key — that is hidden from users and is
one of the behaviours antivirus heuristics score as malware.

## Building from source

```bash
npm install
npm test
```
