# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# React Native itself, Reanimated, Worklets, WebRTC, Firebase and Play Services
# ship consumer rules inside their AARs, so everything reachable through the
# bridge/TurboModule registry survives shrinking without any rule here. The
# rules below cover what those consumer rules do not.

# Crash reports from a shrunk build are unreadable without the original file
# and line numbers; keeping them costs a few kB of dex and keeps production
# stack traces actionable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Native code looks these classes up by their fully-qualified name - either
# through JNI's Java_<mangled_class>_<method> symbol convention or an explicit
# FindClass - so renaming or removing them compiles fine and then fails at
# runtime, when the library first touches native code. None of these libraries
# ship consumer rules of their own.
-keep class com.op.sqlite.** { *; }
-keep class com.margelo.nitro.** { *; }
-keep class com.swmansion.rnscreens.** { *; }
-keep class com.swmansion.gesturehandler.** { *; }

# Modules and view managers are resolved from JS by their declared names.
-keep @com.facebook.react.module.annotations.ReactModule class * { *; }
-keep class * extends com.facebook.react.uimanager.ViewManager { *; }
-keep class * implements com.facebook.react.ReactPackage { *; }

# OkHttp (React Native's networking stack) references optional Conscrypt and
# JSSE providers that are absent at runtime on Android.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
