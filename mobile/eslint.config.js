// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // Upstream minified KaTeX, reproduced by scripts/generate-katex-assets.mjs.
    ignores: ["dist/*", "public/katex/**"],
  }
]);
