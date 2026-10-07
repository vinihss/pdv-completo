import { Audio } from "expo-audio";
import { Asset } from "expo-asset";

let soundRef = null;
let isLoaded = false;

const soundAsset = Asset.fromModule(require("../../../../assets/sounds/alert_order_created.wav"));

async function loadSound() {
  if (isLoaded && soundRef) return soundRef;
  try {
    if (!soundAsset.localUri) {
      await soundAsset.downloadAsync();
    }
    const { sound } = await Audio.Sound.createAsync({ uri: soundAsset.localUri || soundAsset.uri });
    soundRef = sound;
    isLoaded = true;
    return sound;
  } catch (err) {
    console.warn("Failed to load alert sound", err);
    return null;
  }
}

export async function playNativeAlertSound() {
  try {
    const sound = await loadSound();
    if (!sound) return false;
    await sound.setPositionAsync(0);
    await sound.playAsync();
    return true;
  } catch {
    return false;
  }
}

export function unloadNativeAlertSound() {
  if (soundRef) {
    soundRef.unloadAsync().catch(() => {});
    soundRef = null;
    isLoaded = false;
  }
}
