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
}
