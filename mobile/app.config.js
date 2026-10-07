// app.config.js — Um codebase, dois apps.
//
// O mesmo código React Native vira "PDV Garçom" ou "PDV Entregador" conforme
// a variante de build `APP_VARIANT` (ver `shared/lib/variant.js` para o lado
// do JS). Aqui fica toda a identidade nativa que muda entre os dois:
//
//   APP_VARIANT=garcon      → name "PDV Garçom", slug pdv-garcon, com.pdvapp.garcon
//   APP_VARIANT=entregador  → name "PDV Entregador", slug pdv-entregador, com.pdvapp.entregador
//
// As identidades `com.pdvapp.{garcon,entregador}` são as MESMAS dos crates
// Tauri mobile (standalone-garcon/standalone-entregador): nada foi publicado
// nas lojas e manter o id não conflita — se um dia publicar, continua sendo
// o mesmo app.
//
// Default é garcon (o app principal): sem `APP_VARIANT`, você está fazendo o
// app do garçom.

const VARIANT = process.env.APP_VARIANT === "entregador" ? "entregador" : "garcon";

const META = {
  garcon: {
    name: "PDV Garçom",
    slug: "pdv-garcon",
    bundleIdentifier: "com.pdvapp.garcon",
    packageAndroid: "com.pdvapp.garcon",
  },
  entregador: {
    name: "PDV Entregador",
    slug: "pdv-entregador",
    bundleIdentifier: "com.pdvapp.entregador",
    packageAndroid: "com.pdvapp.entregador",
  },
}[VARIANT];

// Permissões nativas por variante. Só declaração: o pedido em runtime é das
// frentes seguintes (expo-location entra na Frente 3, notificações idem).
// Garçom não precisa de nenhuma além das do template.
const ANDROID_PERMISSIONS = VARIANT === "entregador"
  ? ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "POST_NOTIFICATIONS"]
  : [];

// iOS entrega, quandoInUse (a coleta em foreground é o caso de uso do
// produto). Só a descrição — o pedido em runtime vem depois.
const IOS_LOCATION_DESCRIPTION =
  "O PDV Entregador usa sua localização para registrar a entrega enquanto o app está em uso.";

// Descrições iOS do provisionamento (docs/21 §5.2/§5.3). Os config plugins
// também as registram (via mods, que só aparecem no prebuild); declará-las aqui
// deixa o contrato visível em `expo config --type public` e garante o PT-BR.
const IOS_CAMERA_DESCRIPTION =
  "O PDV usa a câmera para ler o QR Code de provisionamento do aparelho.";
const IOS_FACE_ID_DESCRIPTION = "O PDV usa a biometria para desbloquear o aparelho.";
const IOS_MICROPHONE_DESCRIPTION =
  "O PDV usa o microfone apenas para recursos de áudio do app.";

module.exports = ({ config }) => ({
  ...config,
  name: META.name,
  slug: META.slug,
  scheme: META.slug,
  version: "0.1.0",
  orientation: "portrait", // POS é vertical, em todas as telas
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  ios: {
    ...config.ios,
    supportsTablet: false,
    bundleIdentifier: META.bundleIdentifier,
    infoPlist: {
      ...(config.ios?.infoPlist ?? {}),
      NSCameraUsageDescription: IOS_CAMERA_DESCRIPTION,
      NSMicrophoneUsageDescription: IOS_MICROPHONE_DESCRIPTION,
      NSFaceIDUsageDescription: IOS_FACE_ID_DESCRIPTION,
      ...(VARIANT === "entregador"
        ? { NSLocationWhenInUseUsageDescription: IOS_LOCATION_DESCRIPTION }
        : {}),
    },
  },
  android: {
    ...config.android,
    package: META.packageAndroid,
    permissions: ANDROID_PERMISSIONS,
    // Chave do Google Maps SDK (Android). Sem ela, o mapa do Entregador
    // (react-native-maps) fica cinza no release; iOS usa Apple Maps.
    // Lida do ambiente para não commitar segredo.
    config: {
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_API_KEY || undefined,
      },
    },
    adaptiveIcon: {
      backgroundColor: "#0c0a09",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
  },
  // O plano LOCAL do produto usa `http://<ip-lan>:3000` e o Android bloqueia
  // cleartext no release — por isso `usesCleartextTraffic: true` via plugin.
  //
  // Provisionamento (docs/21 §5.2/§5.3): o scanner de QR precisa da câmera, o
  // desbloqueio usa biometria e a credencial do aparelho vive no SecureStore.
  // Os três config plugins registram as permissões nativas nas DUAS variantes
  // (o manifest final soma ao array `android.permissions` de cada uma).
  // expo-camera: `recordAudioAndroid: false` — só lemos QR, não gravamos áudio.
  plugins: [
    ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
    [
      "expo-camera",
      {
        cameraPermission:
          "O PDV usa a câmera para ler o QR Code de provisionamento do aparelho.",
        microphonePermission:
          "O PDV usa o microfone apenas para recursos de áudio do app.",
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-local-authentication",
      {
        faceIDPermission: "O PDV usa a biometria para desbloquear o aparelho.",
      },
    ],
    [
      "expo-secure-store",
      {
        faceIDPermission:
          "O PDV usa o Face ID para proteger a credencial de provisionamento do aparelho.",
        configureAndroidBackup: true,
      },
    ],
  ],
  web: { favicon: "./assets/favicon.png" },
});