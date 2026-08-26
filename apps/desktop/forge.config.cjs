const path = require("node:path");

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.devloop.desktop",
    executableName: "DevLoop",
    icon: path.join(__dirname, "assets", "devloop-app-icon.icns"),
    extraResource: [path.join(__dirname, "runtime-bundle")],
    // 仅将桌面端的生产依赖带入应用，避免把 Forge 等开发工具打进包内。
    prune: true,
    ignore: [
      /^\/node_modules(?:\/|$)/,
      /^\/runtime-bundle(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/assets\/devloop-app-icon\.(?:icns|svg)$/,
      /^\/dist\/.*\.map$/,
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
