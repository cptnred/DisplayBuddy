// Android library of the buddy-push plugin (same layout as the official Tauri plugins,
// e.g. plugins-workspace/plugins/notification/android/build.gradle.kts).
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "de.displaybuddy.push"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    // Firebase Android BoM (release notes 2026-10-21); the BoM pins firebase-messaging.
    // Without google-services.json the library is present but FirebaseApp stays
    // uninitialised and getToken answers NOT_CONFIGURED.
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation(project(":tauri-android"))
    // the background sync schedules through the notification plugin's own classes, so the
    // alarms, storage and ids are the ones the web layer plans with (see BackgroundSync)
    implementation(project(":tauri-plugin-notification"))
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
    testImplementation("junit:junit:4.13.2")
}
