const path = require("node:path");

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.devloop.desktop",
    executableName: "DevLoop",
    extraResource: [path.join(__dirname, "runtime-bundle")],
    prune: false,
    ignore: [
      /^\/node_modules(?:\/|$)/,
      /^\/runtime-bundle(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/forge\.config\.cjs$/,
      /^\/tsconfig\.json$/,
    ],
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
