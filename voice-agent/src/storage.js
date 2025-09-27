// src/storage.js (ESM)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The audio dir is one level up from src/, i.e. /app/audio inside the container.
export const AUDIO_DIR = path.resolve(__dirname, '..', 'audio');

export function ensureAudioDir() {
  try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  } catch (e) {
    // If another thread created it between check+mkdir, ignore EEXIST
    if (e?.code !== 'EEXIST') throw e;
  }
}

export function hasGreeting() {
  try {
    return fs.existsSync(path.join(AUDIO_DIR, 'greeting.wav'));
  } catch {
    return false;
  }
}

export function saveGreeting(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('saveGreeting: buffer is required');
  }
  ensureAudioDir();
  const file = path.join(AUDIO_DIR, 'greeting.wav');
  fs.writeFileSync(file, buffer);
  return { path: file };
}

export function saveWav(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('saveWav: buffer is required');
  }
  ensureAudioDir();
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const file = path.join(AUDIO_DIR, `${id}.wav`);
  fs.writeFileSync(file, buffer);
  return { id, path: file };
}
