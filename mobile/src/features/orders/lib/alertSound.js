// Bipe de alerta com expo-audio. O web sintetiza os tons na Web Audio API
// (880 Hz + 1174,7 Hz — entities/alert/lib/sounds.js); aqui o mesmo timbre é
// um WAV curto (features/orders/assets/alert.wav, gerado por
// mobile/scripts/gen-alert-wav.js) tocado pelo player nativo.
//
// O player é criado sob demanda e reutilizado: o alerta pode repetir a cada
// 30s enquanto não lido e o asset de 33 KB não pode virar um player por toque.

let playerRef = null;

function getPlayer() {
  if (playerRef) return playerRef;
  try {
    // require direto para empacotar o asset no bundle (não via caminho de
    // string, que o Metro não resolve).
    const { createAudioPlayer } = require("expo-audio");
    const asset = require("../assets/alert.wav");
    playerRef = createAudioPlayer(asset);
  } catch {
    playerRef = null;
  }
  return playerRef;
}

/** Toca o bipe. Nunca lança — som é extra, o sino é o essencial. */
export function playAlertBeep() {
  const player = getPlayer();
  if (!player) return false;
  try {
    player.seekTo(0);
    player.play();
    return true;
  } catch {
    return false;
  }
}