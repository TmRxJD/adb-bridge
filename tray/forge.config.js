module.exports = {
  packagerConfig: {
    name: 'ADB Bridge',
    executableName: 'adb-bridge-tray',
    asar: true,
    // Placeholder until the real artwork arrives; see assets/README.md.
    icon: 'assets/icon',
    win32metadata: {
      CompanyName: 'TmRxJD',
      FileDescription: 'ADB Bridge',
      ProductName: 'ADB Bridge',
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: { name: 'adb_bridge_tray', setupIcon: 'assets/icon.ico' },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-deb', platforms: ['linux'], config: { options: { icon: 'assets/icon.png' } } },
  ],
}
