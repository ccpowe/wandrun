import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { setNetworkDiagnosticSink } from "../gateway/network-diagnostics.ts";

type NativeConnectionLiveness = {
  pingIntervalMs: number;
  resetConnections(): void;
  logDiagnostic(message: string): void;
};

const native = Platform.OS === "android"
  ? requireOptionalNativeModule<NativeConnectionLiveness>("WandrunConnectionLiveness") : null;

// Android exports the PING period: foreground recovery uses exactly one period.
// iOS/Expo Go have no native owner; retain the same 15s policy and JS idle fallback.
export const backgroundRecoveryMs = native?.pingIntervalMs ?? 15_000;
export const resetConnections = native ? () => native.resetConnections() : undefined;
setNetworkDiagnosticSink(native ? (message) => native.logDiagnostic(message) : undefined);
