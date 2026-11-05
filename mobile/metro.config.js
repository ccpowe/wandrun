const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const path = require("node:path");
const { withStorybook } = require("@storybook/react-native/withStorybook");

const config = getDefaultConfig(__dirname);
// The gateway and App consume the same generated icon allowlist, not copied enums.
config.watchFolders = [path.resolve(__dirname, "../src/wandrun/gateway")];

module.exports = withStorybook(withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./src/uniwind-types.d.ts",
}), { websockets: false });
