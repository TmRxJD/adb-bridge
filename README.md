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
