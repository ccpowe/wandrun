package io.wandrun.net

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ConnectionLivenessModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WandrunConnectionLiveness")
    // JS uses this same PING period as the long-background threshold (ADR-0053).
    Constants("pingIntervalMs" to ConnectionLiveness.PING_INTERVAL_MS)
    Function("resetConnections") { ConnectionLiveness.resetConnections() }
    Function("logDiagnostic") { message: String -> Log.i("WandrunNet", message); Unit }
  }
}
