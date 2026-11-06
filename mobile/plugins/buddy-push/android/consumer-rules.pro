# The plugin class is found by name (register_android_plugin) and the service by the
# merged manifest; keep both under R8 in release builds.
-keep class de.displaybuddy.push.PushPlugin { *; }
-keep class de.displaybuddy.push.PushService { *; }
