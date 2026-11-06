package com.locationspoofer.helper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Injects mock fixes for gps, network, and (API 31+) fused.
 * Listens on 127.0.0.1:17321. The Mac reaches that port through `adb forward`.
 */
class SimulateService : Service() {
    private val locationManager by lazy { getSystemService(LocationManager::class.java) }
    private val lock = Any()
    private val running = AtomicBoolean(false)
    private val activeProviders = LinkedHashSet<String>()
    private var lastLat: Double? = null
    private var lastLon: Double? = null
    private var lastAccuracy: Float = DEFAULT_ACCURACY
    @Volatile private var frozen = false
    private var server: ServerSocket? = null
    @Volatile private var client: Socket? = null
    private var acceptThread: Thread? = null
    private var republish: ScheduledExecutorService? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startInForeground()
        running.set(true)
        try {
            startCommandServer()
        } catch (e: Exception) {
            Log.e(TAG, "command socket failed", e)
            running.set(false)
            stopSelf()
        }
        republish = Executors.newSingleThreadScheduledExecutor()
        republish?.scheduleAtFixedRate({ republishLast() }, 1, 1, TimeUnit.SECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        running.set(false)
        republish?.shutdownNow()
        republish = null
        closeSockets()
        acceptThread?.join(1500)
        synchronized(lock) {
            lastLat = null
            lastLon = null
            removeProviders()
        }
        super.onDestroy()
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Location simulation",
            NotificationManager.IMPORTANCE_LOW,
        )
        manager.createNotificationChannel(channel)
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Simulating location")
            .setContentText("Location Spoofer is sending mock fixes.")
            .setSmallIcon(R.drawable.ic_stat_pin)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun desiredProviders(): List<String> {
        val names = mutableListOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            names.add(LocationManager.FUSED_PROVIDER)
        }
        return names
    }

    /** @return an error string, or null when every provider that can be registered is ready. */
    private fun ensureProviders(): String? {
        for (name in desiredProviders()) {
            if (activeProviders.contains(name)) continue
            try {
                addProvider(name)
                locationManager.setTestProviderEnabled(name, true)
                activeProviders.add(name)
            } catch (e: SecurityException) {
                Log.w(TAG, "mock location not granted", e)
                return MOCK_DENIED
            } catch (e: IllegalArgumentException) {
                try {
                    locationManager.setTestProviderEnabled(name, true)
                    activeProviders.add(name)
                } catch (enableError: SecurityException) {
                    Log.w(TAG, "mock location not granted", enableError)
                    return MOCK_DENIED
                } catch (enableError: IllegalArgumentException) {
                    if (name == fusedProviderName()) {
                        Log.w(TAG, "fused test provider unavailable", enableError)
                        continue
                    }
                    return enableError.message ?: "could not enable $name"
                }
            }
        }
        if (activeProviders.isEmpty()) return "no test provider could be registered"
        return null
    }

    private fun addProvider(name: String) {
        locationManager.addTestProvider(
            name,
            false,
            false,
            false,
            false,
            true,
            true,
            true,
            Criteria.POWER_LOW,
            Criteria.ACCURACY_FINE,
        )
    }

    private fun removeProviders() {
        for (name in activeProviders.toList()) {
            try {
                locationManager.setTestProviderEnabled(name, false)
            } catch (e: Exception) {
                Log.w(TAG, "disable $name failed", e)
            }
            try {
                locationManager.removeTestProvider(name)
            } catch (e: Exception) {
                Log.w(TAG, "remove $name failed", e)
            }
        }
        activeProviders.clear()
    }

    /** @return an error string, or null after the fix is written to every active provider. */
    private fun publish(lat: Double, lon: Double, acc: Float): String? {
        val error = ensureProviders()
        if (error != null) return error
        for (name in activeProviders) {
            try {
                locationManager.setTestProviderLocation(name, fix(name, lat, lon, acc))
            } catch (e: SecurityException) {
                Log.w(TAG, "set $name denied", e)
                return MOCK_DENIED
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "set $name rejected", e)
                return e.message ?: "provider rejected the fix"
            }
        }
        return null
    }

    private fun fix(provider: String, lat: Double, lon: Double, acc: Float): Location {
        return Location(provider).apply {
            latitude = lat
            longitude = lon
            accuracy = acc
            time = System.currentTimeMillis()
            elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
            altitude = 0.0
            speed = 0.5f
            bearing = 0f
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                verticalAccuracyMeters = 5f
                speedAccuracyMetersPerSecond = 0.1f
                bearingAccuracyDegrees = 5f
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                isMock = true
            }
        }
    }

    private fun republishLast() {
        if (frozen) return
        synchronized(lock) {
            val lat = lastLat ?: return
            val lon = lastLon ?: return
            val error = publish(lat, lon, lastAccuracy)
            if (error != null) Log.w(TAG, "republish failed: $error")
        }
    }

    private fun handle(line: String): String {
        val parts = line.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (parts.isEmpty()) return "ERR empty command"
        return when (parts[0].uppercase()) {
            "PING" -> "OK"
            "FREEZE" -> {
                frozen = true
                "OK"
            }
            "RESUME" -> {
                frozen = false
                "OK"
            }
            "CLEAR" -> synchronized(lock) {
                frozen = false
                lastLat = null
                lastLon = null
                removeProviders()
                "OK"
            }
            "SET" -> {
                if (parts.size != 3 && parts.size != 4) return "ERR expected SET <lat> <lon> [accuracy]"
                val lat = parts[1].toDoubleOrNull()
                val lon = parts[2].toDoubleOrNull()
                if (lat == null || lon == null) return "ERR lat and lon must be numbers"
                if (lat !in -90.0..90.0 || lon !in -180.0..180.0) return "ERR lat or lon out of range"
                val acc = if (parts.size == 4) parts[3].toFloatOrNull() else DEFAULT_ACCURACY
                if (acc == null || acc <= 0f || acc > 10000f) return "ERR accuracy must be 0-10000 m"
                synchronized(lock) {
                    val error = publish(lat, lon, acc)
                    if (error != null) {
                        "ERR $error"
                    } else {
                        lastLat = lat
                        lastLon = lon
                        lastAccuracy = acc
                        "OK"
                    }
                }
            }
            else -> "ERR unknown command"
        }
    }

    private fun startCommandServer() {
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT))
        server = socket
        acceptThread = Thread({
            while (running.get()) {
                val accepted = try {
                    socket.accept()
                } catch (e: Exception) {
                    if (running.get()) Log.w(TAG, "accept failed", e)
                    break
                }
                handleClient(accepted)
            }
        }, "helper-accept")
        acceptThread?.isDaemon = true
        acceptThread?.start()
    }

    private fun handleClient(accepted: Socket) {
        client = accepted
        accepted.use { socket ->
            socket.soTimeout = 1000
            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
            val writer = BufferedWriter(OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8))
            while (running.get()) {
                val line = try {
                    reader.readLine()
                } catch (_: SocketTimeoutException) {
                    continue
                } ?: break
                writer.write(handle(line))
                writer.write("\n")
                writer.flush()
            }
        }
        if (client === accepted) client = null
    }

    private fun closeSockets() {
        try {
            server?.close()
        } catch (e: Exception) {
            Log.w(TAG, "close server failed", e)
        }
        server = null
        try {
            client?.close()
        } catch (e: Exception) {
            Log.w(TAG, "close client failed", e)
        }
    }

    private fun fusedProviderName(): String? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) LocationManager.FUSED_PROVIDER else null
    }

    companion object {
        private const val TAG = "SimulateService"
        private const val CHANNEL_ID = "simulate"
        private const val NOTIFICATION_ID = 1
        private const val PORT = 17321
        private const val DEFAULT_ACCURACY = 5f
        private const val MOCK_DENIED =
            "mock location is not granted. Select Location Spoofer Helper in Developer options."
    }
}
