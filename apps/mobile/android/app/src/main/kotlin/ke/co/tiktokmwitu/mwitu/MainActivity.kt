package ke.co.tiktokmwitu.mwitu

import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val preferences = getSharedPreferences("mwitu_updates", MODE_PRIVATE)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "mwitu/android_updates")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "state" -> {
                        @Suppress("DEPRECATION")
                        val versionCode = packageManager.getPackageInfo(packageName, 0).versionCode
                        result.success(mapOf(
                            "versionCode" to versionCode,
                            "sdkInt" to Build.VERSION.SDK_INT,
                            "snoozedVersionCode" to preferences.getInt("versionCode", 0),
                            "snoozedUntil" to preferences.getLong("until", 0L)
                        ))
                    }
                    "snooze" -> {
                        val versionCode = call.argument<Int>("versionCode")
                        if (versionCode == null || versionCode <= 0) {
                            result.error("invalid_version", "A release version code is required.", null)
                        } else {
                            preferences.edit()
                                .putInt("versionCode", versionCode)
                                .putLong("until", System.currentTimeMillis() + 24 * 60 * 60 * 1000L)
                                .apply()
                            result.success(null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
