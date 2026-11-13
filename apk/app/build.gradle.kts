plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "app.massa"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "app.massa"
        minSdk = 23
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            optimization {
                enable = true
                packageScope = setOf("androidx.**", "kotlin.**", "kotlinx.**")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    // GeckoView несёт внутри нативные библиотеки — пакуем их как есть
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    // отдельные APK под архитектуры: arm64 для современных телефонов,
    // armeabi-v7a для старых 32-битных, universal — запасной
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86_64")
            isUniversalApk = true
        }
    }
}

dependencies {
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    implementation(libs.geckoview)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}
