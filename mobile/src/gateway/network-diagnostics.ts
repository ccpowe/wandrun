// Only call-site-owned classifications and numeric metadata belong here. Never pass
// URLs, headers, bodies, or exception messages (native errors may embed request URLs).
let nativeLog: ((message: string) => void) | undefined;

export function setNetworkDiagnosticSink(log: ((message: string) => void) | undefined): void {
  nativeLog = log;
}

export function networkDiagnostic(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  const message = JSON.stringify({ event, ...fields });
  if (nativeLog) nativeLog(message);
  else console.info(`[WandrunNet] ${message}`);
}
