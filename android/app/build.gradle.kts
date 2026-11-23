import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Single source of truth for the version: the app's package.json.
val appVersion = (JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<*, *>)["version"] as String
val (major, minor, patch) = appVersion.split(".").map { it.toInt() }

// Release signing comes from environment variables (set in CI); local builds fall back to the debug key.
val keystorePath: String? = System.getenv("SIGNING_KEYSTORE")

android {
    namespace = "io.github.megaheroxx.temialcontrol"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.megaheroxx.temialcontrol"
        minSdk = 26
        targetSdk = 35
        versionCode = major * 10000 + minor * 100 + patch
        versionName = appVersion
    }

    signingConfigs {
        create("release") {
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storePassword = System.getenv("SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("SIGNING_KEY_ALIAS")
                keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (keystorePath != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // QR scanner that runs fully inside the app (ZXing, Apache-2.0) – no Google Play services needed.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
}
