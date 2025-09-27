import fs from 'fs';
import yaml from 'js-yaml';


export function loadConfig() {
  const path = '/app/config.yml';
  let fileCfg = {};
  try {
    const raw = fs.readFileSync(path, 'utf8');
    fileCfg = yaml.load(raw) || {};
  } catch (e) {
    console.warn(`[config] Could not read ${path}, using defaults.`, e?.message);
  }


  const envCfg = {
    port: parseInt(process.env.PORT || '3000', 10),
    greeting: process.env.GREETING_TEXT || 'Hello! How can I help?',
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      validateSignature: (process.env.TWILIO_VALIDATE_SIGNATURE || 'true').toLowerCase() === 'true'
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
      ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_TTS_VOICE || 'coral'
    },
    host: process.env.VOICE_AGENT_HOST
  };


  return {
    system_prompt: 'You are a helpful, concise, friendly voice assistant.',
    max_response_chars: 600,
    language: 'en-US',
    audio: { format: 'wav', sample_rate_hz: 16000 },
    ...fileCfg,
    env: envCfg
  };
}
