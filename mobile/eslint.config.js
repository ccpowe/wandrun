// https://docs.expo.dev/guides/using-eslint/
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { defineConfig } = require('eslint/config');
const { builtinRules } = require('eslint/use-at-your-own-risk');
const expoConfig = require("eslint-config-expo/flat");
const reactNative = require('eslint-plugin-react-native');
const tailwindColors = require('tailwindcss/colors');

// The upstream rule covers StyleSheet.create and JSX style props, not standalone objects or color props.
const colorProperty = 'Property:matches([key.name=/color$/i], [key.value=/color$/i]) > Literal.value[value=/^(#|[a-z])/i]';
const colorUtility = String.raw`(?:bg|text|decoration|border(?:-[trblxyse])?|divide(?:-[xy])?|outline|ring(?:-offset)?|shadow|accent|caret|fill|stroke|from|via|to)`;
const arbitraryColor = String.raw`${colorUtility}-\[(?:color:)?(?:#|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|[a-z]+\])`;
// Derive both vocabularies from their owners, including semantic overrides of palette names.
const semanticColors = new Set(
  [...readFileSync(join(__dirname, 'global.css'), 'utf8').matchAll(/--color-([\w-]+)\s*:/g)]
    .map(match => match[1])
);
const fixedColors = Object.entries(tailwindColors)
  .flatMap(([name, value]) => typeof value === 'string'
    ? (['inherit', 'current'].includes(name) ? [] : [name])
    : Object.keys(value).map(shade => `${name}-${shade}`))
  .filter(name => !semanticColors.has(name));
// Colon admits variant prefixes; token boundaries avoid matching filenames or longer semantic names.
const fixedColorClass = String.raw`(?:^|[\s:])!?${colorUtility}-(?:${fixedColors.join('|')})(?:\u002f[^\s!]+)?!?(?=\s|$)`;
const colorAttribute = 'JSXAttribute[name.name=/(?:color|fill|stroke)$/i]';
const restrictedSyntax = [
  {
    selector: 'CallExpression[callee.type="MemberExpression"][callee.property.name=/^(duration|delay)$/] > Literal.arguments[value=type(number)]',
    message: 'Animation durations and delays must come from src/lib/motion.ts.',
  },
  {
    selector: 'Property:matches([key.name=/^(duration|delay|animationDuration|transitionDuration)$/], [key.value=/^(duration|delay|animationDuration|transitionDuration)$/]) > Literal.value[value=type(number)]',
    message: 'Animation durations and delays must come from src/lib/motion.ts.',
  },
  {
    selector: 'CallExpression[callee.name="withDelay"] > Literal.arguments:first-child[value=type(number)]',
    message: 'Animation delays must come from src/lib/motion.ts.',
  },
  {
    selector: 'JSXAttribute[name.name=/^(duration|delay|animationDuration|transitionDuration|transition)$/] > JSXExpressionContainer > Literal[value=type(number)]',
    message: 'Animation durations must come from src/lib/motion.ts.',
  },
  {
    selector: 'VariableDeclarator > :matches(ObjectExpression, TSAsExpression, TSSatisfiesExpression) ' + colorProperty,
    message: 'Use theme variables instead of color literals in style objects.',
  },
  {
    selector: `:matches(${colorAttribute} > Literal, ${colorAttribute} > JSXExpressionContainer > Literal)[value=type(string)][value!=/^(currentColor|inherit|none)$/i]`,
    message: 'Use theme variables instead of color literals in component props.',
  },
  {
    // Check strings in cn()/variants/constants too, not only direct JSX className attributes.
    selector: `Literal[value=/${arbitraryColor}/i], TemplateElement[value.raw=/${arbitraryColor}/i]`,
    message: 'Use semantic theme classes instead of arbitrary color values.',
  },
  {
    selector: `Literal[value=/${fixedColorClass}/], TemplateElement[value.raw=/${fixedColorClass}/]`,
    message: 'Use semantic theme classes instead of fixed palette colors.',
  },
  {
    selector: String.raw`Literal[value=/(duration|delay)-[0-9]/], TemplateElement[value.raw=/(duration|delay)-[0-9]/]`,
    message: 'Animation duration classes must come from src/lib/motion.ts.',
  },
];

const effectMessage = 'Do not use useEffect or useLayoutEffect directly. See mobile/docs/react-guidelines.md §3 for alternatives (useMountEffect, useMeasureLayout, useFocusEffect, useSyncExternalStore, useEffectEvent, event handlers, or key remounts).';
const effectRestrictions = Object.fromEntries(['useEffect', 'useLayoutEffect'].map(hook => [hook, [
  {
    selector: `ImportDeclaration[source.value="react"] > ImportSpecifier[imported.name="${hook}"]`,
    message: effectMessage,
  },
  {
    selector: `CallExpression[callee.name="${hook}"]`,
    message: effectMessage,
  },
  {
    // Reserve the property too, covering namespace aliases and computed access.
    selector: `MemberExpression:matches([computed=false][property.name="${hook}"], [computed=true][property.value="${hook}"])`,
    message: effectMessage,
  },
  {
    selector: `ObjectPattern > Property:matches([key.name="${hook}"], [key.value="${hook}"])`,
    message: effectMessage,
  },
  {
    // A static template is also a property name; interpolated names remain outside this policy.
    selector: `:matches(MemberExpression[computed=true] > TemplateLiteral.property, ObjectPattern > Property[computed=true] > TemplateLiteral.key)[expressions.length=0] > TemplateElement[value.cooked="${hook}"]`,
    message: effectMessage,
  },
]]));
const restrictedProperties = [{
  object: 'Alert',
  property: 'alert',
  message: 'Present errors inline and use the component-library dialog for confirmation.',
}, {
  property: 'throwIfAborted',
  message: 'React Native AbortSignal does not support throwIfAborted; use assertNotAborted from src/lib/abort.ts.',
}];

module.exports = defineConfig([
  expoConfig,
  {
    // Upstream minified KaTeX, reproduced by scripts/generate-katex-assets.mjs.
    ignores: ["dist/*", "public/katex/**"],
  },
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      'react-native': reactNative,
      // Reuse ESLint's selector engine under a separate suppression budget.
      wandrun: { rules: { 'no-use-effect': builtinRules.get('no-restricted-syntax') } },
    },
    settings: { 'react-hooks': { additionalEffectHooks: '^(useMountEffect|useMeasureLayout|useRuntimeCommit)$' } },
    rules: {
      'react-native/no-color-literals': 'error',
      'no-restricted-syntax': ['error', ...restrictedSyntax],
      'no-restricted-properties': ['error', ...restrictedProperties],
      'wandrun/no-use-effect': ['error', ...Object.values(effectRestrictions).flat()],
    },
  },
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/browser/**', 'src/lib/use-runtime-commit.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        regex: '(^|/)use-runtime-commit(?:\\.[cm]?[jt]sx?)?$',
        message: 'useRuntimeCommit is reserved for browser runtime bridges; see React guidelines §3.',
      }] }],
    },
  },
  {
    files: ['src/lib/motion.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // The only mount-only adapter; all unrelated restrictions still apply.
    files: ['src/lib/use-mount-effect.ts'],
    rules: {
      'wandrun/no-use-effect': ['error', ...effectRestrictions.useLayoutEffect],
    },
  },
  {
    // Only this adapter may use the pre-paint measurement primitive.
    files: ['src/lib/use-measure-layout.ts'],
    rules: {
      'wandrun/no-use-effect': ['error', ...effectRestrictions.useEffect],
    },
  },
  {
    // Commit-only callback publication; this API cannot run arbitrary effects.
    files: ['src/lib/use-runtime-commit.ts'],
    rules: {
      'wandrun/no-use-effect': ['error', ...effectRestrictions.useEffect],
    },
  },
]);
