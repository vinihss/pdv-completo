#!/usr/bin/env node
// Gera o asset WAV do bipe de alerta (features/orders/assets/alert.wav) a
// partir das mesmas frequências do web (frontend/src/shared/lib/audio.js +
// entities/alert/lib/sounds.js): 880 Hz por 0.14s, pausa de 0.04s e a quinta
// 1174,7 Hz por 0.2s. É o mesmo "som de balcão" que o PWA sintetiza com a Web
// Audio API — aqui num arquivo para o expo-audio tocar.
//
// Rode `node mobile/scripts/gen-alert-wav.js` depois de alterar os tons. O WAV
// sai 16-bit PCM mono 44.1 kHz, compacto o bastante para ser embutido no app.
const fs = require("node:fs");
const path = require("node:path");

const SAMPLE_RATE = 44100;
const AMPLITUDE = 0.5;

// [{ freq, at, duration }] — mesmos valores de ALERT_SOUNDS.order_created.
const TONES = [
  { freq: 880, at: 0, duration: 0.14 },
  { freq: 1174.7, at: 0.18, duration: 0.2 },
];

function buildPcm() {
  const totalSamples = Math.ceil((TONES[TONES.length - 1].at + TONES[TONES.length - 1].duration) * SAMPLE_RATE);
  const samples = new Int16Array(totalSamples);
  const phases = TONES.map(() => 0);
  for (let n = 0; n < totalSamples; n++) {
    const t = n / SAMPLE_RATE;
    let value = 0;
    for (let i = 0; i < TONES.length; i++) {
      const { freq, at, duration } = TONES[i];
      const local = t - at;
      if (local < 0 || local > duration) continue;
      phases[i] += (2 * Math.PI * freq) / SAMPLE_RATE;
      const fadeIn = Math.min(1, local / 0.01);
      const fadeOut = Math.min(1, (duration - local) / 0.03);
      value += Math.sin(phases[i]) * AMPLITUDE * Math.min(fadeIn, fadeOut);
    }
    samples[n] = Math.max(-1, Math.min(1, value)) * 32767;
  }
  return samples;
}

function wavFromPcm(pcm) {
  const dataSize = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buffer, 44);
  return buffer;
}

function main() {
  const outDir = path.join(__dirname, "..", "src", "features", "orders", "assets");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "alert.wav");
  fs.writeFileSync(outPath, wavFromPcm(buildPcm()));
  console.log(`gerado: ${outPath} (${fs.statSync(outPath).size} bytes)`);
}

main();