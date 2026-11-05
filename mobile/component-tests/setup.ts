/// <reference types="jest" />
import 'react-native-gesture-handler/jestSetup';
import { assertNoUnhandledGatewayRequests } from '../src/dev/fake-gateway';
// The device preference uses AsyncStorage's official in-memory native-boundary mock.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

afterEach(() => assertNoUnhandledGatewayRequests());

// jest-expo locates package mocks from the requireNativeModule caller's stack. Our dev
// adapter is outside expo-file-system; explicitly reuse that package's official mock.
jest.mock('expo', () => {
  const actual = jest.requireActual('expo');
  const packageRoot = require('node:path').dirname(require.resolve('expo-file-system/package.json'));
  return { ...actual, requireNativeModule: (name: string) => name === 'FileSystem'
    ? jest.requireActual(`${packageRoot}/mocks/FileSystem`)
    : actual.requireNativeModule(name) };
});
// Official Worklets mock must precede Reanimated's mock (Reanimated 4 imports its runtime).
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => {
  const native = require('react-native-reanimated/mock');
  return {
    ...native,
    // Reanimated's official 4.5 mock leaves these native-runtime exports unimplemented.
    // Sortables stays real; no UI-thread geometry/gesture claims are made by L2.
    LayoutAnimationConfig: ({ children }: { children?: React.ReactNode }) => children,
    isWorkletFunction: require('react-native-worklets/src/mock').isWorkletFunction,
    makeMutable: (value: unknown) => ({
      value,
      modify(update: (previous: unknown) => unknown) { this.value = update(this.value); },
    }),
    isSharedValue: (value: unknown) => !!value && typeof value === 'object' && 'value' in value,
    useFrameCallback: () => ({ setActive() {}, isActive: false }),
  };
});
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// jest-expo's automatic native proxy does not model EventSubscription.remove or a route snapshot.
jest.mock('expo-network', () => ({
  ...jest.requireActual('expo-network'),
  addNetworkStateListener: jest.fn(() => ({ remove() {} })),
  getNetworkStateAsync: jest.fn(async () => ({ type: 'WIFI', isConnected: true })),
}));
