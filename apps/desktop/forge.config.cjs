module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.devloop.desktop",
    executableName: "DevLoop",
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-dmg",
      config: {
        name: "DevLoop",
      },
    },
  ],
};
