import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Chave de assinatura do release. O template do Tauri não declara
// `signingConfigs`, então o `assembleRelease` sai como
// `app-release-unsigned.apk` — que o Android não instala. O keystore é
// material de máquina (nunca entra no git: `keystore.properties` e
// `*.keystore` estão no .gitignore deste diretório) e é lido daqui:
//
//   keystore.properties
//     storeFile=../pdv-garcon.keystore   (relativo a este diretório app/)
//     storePassword=...
//     keyAlias=pdv-garcon
//     keyPassword=...
//
// Sem o arquivo, o release continua buildando (só sai sem assinar) — é o
// caminho de quem só quer conferir o bundle. Ver standalone-garcon/README.md.
val keystoreProperties = Properties().apply {
    val propFile = file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val hasReleaseKeystore = keystoreProperties.getProperty("storeFile") != null

// Lê uma chave TOML de uma seção, sem deixar a seção vizinha contaminar
// (o `version` de outra seção não vale). Comentários são ignorados.
fun tomlSectionValue(cargoToml: File, section: String, key: String): String? {
    if (!cargoToml.exists()) return null
    var current = ""
    for (raw in cargoToml.readLines()) {
        val line = raw.trim()
        if (line.isEmpty() || line.startsWith("#")) continue
        if (line.startsWith("[")) {
            current = line.removePrefix("[").substringBefore("]")
            continue
        }
        if (current != section) continue
        val eq = line.indexOf('=')
        if (eq < 0) continue
        if (line.substring(0, eq).trim() != key) continue
        return line.substring(eq + 1).trim().trim('"')
    }
    return null
}

// Versão do APK.
//
// O template lê `tauri.properties` (`tauri.android.versionName/versionCode`),
// mas **nada escreve esse arquivo** — sem ele os dois caem no default "1.0"/1
// e o APK sai mentindo sobre a versão do app (foi o que aconteceu no primeiro
// build). A fonte de verdade da família é `[workspace.package].version` do
// Cargo.toml da raiz — é o que o `scripts/release/bump-version.sh` altera e o que os 4 apps
// herdam via `version.workspace` — então é de lá que se lê. O tauri.properties
// segue como primeira escolha, caso uma versão futura da CLI passe a gerá-lo.
val appVersionName: String =
    tauriProperties.getProperty("tauri.android.versionName")
        ?: tomlSectionValue(file("../../../../Cargo.toml"), "workspace.package", "version")
        ?: tomlSectionValue(file("../../../Cargo.toml"), "package", "version")
        ?: "1.0"

// O versionCode precisa ser estritamente crescente a cada publicação. Derivar
// da semver (`major*1_000_000 + minor*1_000 + patch`) mantém 0.1.0 → 1000,
// 0.2.0 → 2000, 1.0.0 → 1000000, sem colisão para minor/patch < 1000.
val appVersionCode: Int =
    tauriProperties.getProperty("tauri.android.versionCode")?.toIntOrNull()
        ?: run {
            val parts = appVersionName.split(".")
            fun part(i: Int) = parts.getOrNull(i)?.toIntOrNull() ?: 0
            part(0) * 1_000_000 + part(1) * 1_000 + part(2)
        }

android {
    compileSdk = 36
    namespace = "com.pdvapp.garcon"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.pdvapp.garcon"
        minSdk = 24
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }
    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // O template só liga o cleartext no debug, e isso quebraria o plano
            // LOCAL do produto: o backend roda em `http://<ip-da-lan>:3000`, e
            // a partir do targetSdk 28 o Android bloqueia socket em claro para
            // QUALQUER biblioteca — inclusive o `tauri-plugin-http` (reqwest)
            // que é por onde este app fala com a API. Bloqueado, o app não
            // conecta e não dá erro visível: só time out. O desktop nunca teve
            // esse bloqueio, então liberar aqui mantém os dois apps iguais.
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isMinifyEnabled = true
            signingConfig = signingConfigs.findByName("release")
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")