#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../../assets/sounds");
import { mkdirSync } from "node:fs";

function generateWav() {
  // 44.1kHz
  const sampleRate = 44100;
  // Generate short chime: 880Hz + 1174.7Hz
  const duration = 0.6; // total 600ms like the web pattern
  const samples = Math.floor(sampleRate * duration);
  const buffer = Buffer.alloc(samples * 2);
  const t1Start = 0;
  const t1End = 0.14;
  const t2Start = 0.18;
  const t2End = 0.38;

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    let v = 0;
    // tone 1
    if (t >= t1Start && t < t1End) {
      v += 0.14 * Math.sin(2 * Math.PI * 880 * (t - t1Start));
    }
    // tone 2
    if (t >= t2Start && t < t2End) {
      v += 0.13 * Math.sin(2 * Math.PI * 1174.7 * (t - t2Start));
    }
    // fade out
    const fade = 1 - (t - Math.max(t1Start, t2Start)) / Math.max(0.0001, t2End - t2Start);
    v *= Math.max(0, fade);
    const val = Math.max(-1, Math.min(1, v));
    const s = Math.floor(val * 0x7fff);
    buffer.writeInt16LE(s, i * 2);
  }

  mkdirSync(outDir, { recursive: true });

  // Simple WAV header (PCM 16-bit mono)
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + buffer.length, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16); // PCM
  wavHeader.writeUInt16LE(1, 20); // format
  wavHeader.writeUInt16LE(1, 22); // channels
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wavHeader.writeUInt16LE(2, 32); // block align
  wavHeader.writeUInt16LE(16, 34); // bits per sample
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(buffer.length, 40);
  const wav = Buffer.concat([wavHeader, buffer]);
  writeFileSync(join(outDir, "alert_order_created.wav"), wav);
  console.log("Generated", join(outDir, "alert_order_created.wav"));
}

generateWav();
