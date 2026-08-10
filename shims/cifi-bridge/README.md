# cifi-bridge

**CIFI support has moved to [adb-bridge](https://www.npmjs.com/package/adb-bridge).**

This package still works. It enables CIFI on adb-bridge and hands over, so
existing instructions, scripts and shortcuts keep doing what they did.

```bash
npx adb-bridge
```

adb-bridge serves several games from one install, on the same ports, so you no
longer need a separate bridge per game. If you had another one installed, its
startup entry is removed the first time this runs — two bridges starting at
sign-in would compete for the same port.

Licensed GPL-3.0-or-later.
