# ProGuard / R8 rules for Phone Notify
# ──────────────────────────────────────
# These rules prevent the release build from stripping classes that are
# accessed reflectively (OkHttp, okio) or referenced only from XML/manifests.

# ── OkHttp3 ──────────────────────────────────────────────────────────────────
# OkHttp uses reflection for platform detection and SSL pinning.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }
-keep class okio.** { *; }

# ── org.json (Android built-in, but keep for safety) ─────────────────────────
-keep class org.json.** { *; }

# ── Phone Notify app classes ──────────────────────────────────────────────────
# Keep all app classes in the com.phonenotify.app package.
# These are referenced by name from XML (AndroidManifest, layout).
-keep class com.phonenotify.app.** { *; }

# ── Android NotificationListenerService ──────────────────────────────────────
# Required so R8 does not rename or remove the service class.
-keep class * extends android.service.notification.NotificationListenerService { *; }

# ── Kotlin metadata (required for Kotlin reflection) ─────────────────────────
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes EnclosingMethod
