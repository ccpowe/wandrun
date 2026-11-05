module.exports = {
  cacheDirectory: process.env.WANDRUN_JEST_CACHE_DIR || '<rootDir>/.cache/jest',
  preset: 'jest-expo',
  transform: { '\\.mjs$': require('jest-expo/jest-preset').transform['\\.[jt]sx?$'] },
  testMatch: ['<rootDir>/component-tests/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/component-tests/setup.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transformIgnorePatterns: ['node_modules/(?!(?:jest-)?react-native|@react-native|expo|@expo|@react-navigation|@storybook|storybook|@rn-primitives|uniwind|lucide-react-native|standard-navigation|markdown-it-cjk-friendly|get-east-asian-width)'],
  maxWorkers: 2,
  workerIdleMemoryLimit: '768MB',
};
