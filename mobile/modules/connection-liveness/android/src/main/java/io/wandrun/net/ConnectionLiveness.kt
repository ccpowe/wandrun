package io.wandrun.net

import android.content.Context
import android.util.Log
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.network.ReactCookieJarContainer
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import okhttp3.Call
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.Protocol

/** Process-wide transport ownership, including clients derived by Expo's newBuilder(). */
internal object ConnectionLiveness {
  const val PING_INTERVAL_MS = 15_000L
  private const val TAG = "WandrunNet"
  private val gate = Any()
  private val sockets = mutableSetOf<Socket>()
  private val calls = mutableSetOf<Call>()
  private val pool = ConnectionPool()
  private val dispatcher = Dispatcher()
  private var installed = false

  fun install(context: Context) = synchronized(gate) {
    if (installed) return@synchronized
    // Build RN's cache once, but give each consumer its own RN cookie container:
    // Expo casts it to CookieJarContainer and sets/removes its forwarding cookie jar.
    val base = OkHttpClientProvider.createClientBuilder(context)
      .connectionPool(pool)
      .dispatcher(dispatcher)
      .socketFactory(TrackedSocketFactory())
      .pingInterval(PING_INTERVAL_MS, TimeUnit.MILLISECONDS)
      .connectTimeout(15, TimeUnit.SECONDS)
      .addInterceptor { chain ->
        val request = chain.request()
        val timed = if (request.header("Accept") == "text/event-stream") {
          chain.withReadTimeout(45, TimeUnit.SECONDS)
        } else chain
        timed.proceed(request)
      }
      .eventListenerFactory { TransportEvents() }
      .build()
    OkHttpClientProvider.setOkHttpClientFactory(object : OkHttpClientFactory {
      override fun createNewNetworkModuleClient(): OkHttpClient =
        base.newBuilder().cookieJar(ReactCookieJarContainer()).build()
    })
    installed = true
    Log.i(TAG, "factory_installed ping_ms=$PING_INTERVAL_MS")
  }

  /**
   * Synchronous reset boundary: cancel old calls to prevent OkHttp retrying commands,
   * then close raw TCP sockets (also active HTTP/2 and HTTP CONNECT tunnels).
   * evictAll alone only closes idle connections. Socket creation and callStart share
   * this gate, so a caller starting after return cannot acquire an old live TCP.
   * OkHttp 4.9.2 RealConnection.isHealthy checks rawSocket.isClosed before reuse.
   */
  fun resetConnections(): Unit = synchronized(gate) {
    val interrupted = calls.toList()
    val existing = sockets.toList()
    interrupted.forEach { it.cancel() }
    calls.clear()
    var failure: IOException? = null
    for (socket in existing) {
      try {
        socket.close()
      } catch (error: IOException) {
        failure = error
      }
    }
    pool.evictAll()
    Log.i(TAG, "reset calls=${interrupted.size} sockets_closed=${existing.count { it.isClosed }} failure=${failure?.javaClass?.simpleName ?: "none"}")
    // Never report a successful boundary if a socket could not be closed.
    failure?.let { throw it }
  }

  private class TrackedSocket : Socket() {
    override fun close() {
      super.close()
      synchronized(gate) { sockets.remove(this) }
    }
  }

  private class TrackedSocketFactory : SocketFactory() {
    // OkHttp uses this overload for DIRECT and HTTP proxies, including CONNECT.
    override fun createSocket(): Socket = synchronized(gate) {
      TrackedSocket().also { sockets.add(it) }
    }

    private fun connected(remote: InetSocketAddress, local: InetSocketAddress? = null): Socket {
      val socket = createSocket()
      try {
        if (local != null) socket.bind(local)
        socket.connect(remote)
        return socket
      } catch (error: IOException) {
        socket.close()
        throw error
      }
    }

    override fun createSocket(host: String, port: Int): Socket = connected(InetSocketAddress(host, port))
    override fun createSocket(host: InetAddress, port: Int): Socket = connected(InetSocketAddress(host, port))
    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket =
      connected(InetSocketAddress(host, port), InetSocketAddress(local, localPort))
    override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket =
      connected(InetSocketAddress(host, port), InetSocketAddress(local, localPort))
  }

  private class TransportEvents : EventListener() {
    private var connectionInfo = "connection=none"
    private fun record(call: Call, event: String, detail: String = "") {
      // No URL, headers, exception message/stack, or body: exceptions can contain URLs.
      Log.i(TAG, "call=${System.identityHashCode(call)} $event $connectionInfo $detail")
    }

    override fun callStart(call: Call) {
      synchronized(gate) { calls.add(call) }
      record(call, "start")
    }

    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
      record(call, "connect_start", "proxy=${proxy.type()}")
    }

    override fun connectionAcquired(call: Call, connection: Connection) {
      connectionInfo = "connection=${System.identityHashCode(connection)} protocol=${connection.protocol()} proxy=${connection.route().proxy.type()} local_port=${connection.socket().localPort}"
      record(call, "acquired")
    }

    override fun connectionReleased(call: Call, connection: Connection) {
      record(call, "released")
    }

    override fun connectFailed(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?, ioe: IOException) {
      record(call, "connect_failed", "proxy=${proxy.type()} reason=${ioe.javaClass.simpleName}")
    }

    override fun callFailed(call: Call, ioe: IOException) {
      synchronized(gate) { calls.remove(call) }
      record(call, "failed", "reason=${ioe.javaClass.simpleName} cancelled=${call.isCanceled()}")
    }

    override fun callEnd(call: Call) {
      synchronized(gate) { calls.remove(call) }
      record(call, "end")
    }
  }
}
