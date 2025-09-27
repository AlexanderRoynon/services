import fetch from 'node-fetch';

const OAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

function logInfo(obj, msg) {
  // light-weight logger that won't crash if console is redirected
  try { console.info('[openai]', msg, obj || ''); } catch {}
}

export async function chatReply({ apiKey, model, system, user }) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user }
    ],
    temperature: 0.5
  };

  logInfo({ model }, 'chat → request');
  const r = await fetch(`${OAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    logInfo({ status: r.status, ct, err: txt.slice(0, 300) }, 'chat ← error');
    throw new Error(`OpenAI chat error ${r.status} ct=${ct}: ${txt}`);
  }

  const j = await r.json();
  const content = j.choices?.[0]?.message?.content?.trim() || '';
  logInfo({ status: r.status, ct, chars: content.length }, 'chat ← ok');
  return content;
}

/**
 * Text → WAV via OpenAI Audio Speech.
 * Forces WAV with `response_format: "wav"` and validates RIFF/WAVE.
 */
export async function synthesizeWavStrict({
  apiKey,
  text,
  model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  voice = process.env.OPENAI_TTS_VOICE || 'coral'
}) {
  const body = { model, input: text, voice, response_format: 'wav' };

  logInfo({ model, voice, response_format: 'wav', chars: text?.length || 0 }, 'tts → request');
  const r = await fetch(`${OAI_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'audio/wav'
    },
    body: JSON.stringify(body)
  });

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());

  if (!r.ok) {
    const preview = buf.slice(0, 200).toString('utf8');
    logInfo({ status: r.status, ct, head: preview }, 'tts ← error');
    throw new Error(`OpenAI TTS error ${r.status} ct=${ct}: ${preview}`);
  }
  if (!ct.includes('audio')) {
    const preview = buf.slice(0, 200).toString('utf8');
    logInfo({ status: r.status, ct, head: preview }, 'tts ← non-audio');
    throw new Error(`OpenAI TTS returned non-audio ct=${ct || 'unknown'}; head=${JSON.stringify(preview)}`);
  }

  // Must be a real WAV container
  const looksLikeWav =
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WAVE';

  if (!looksLikeWav) {
    const headHex = buf.slice(0, 32).toString('hex');
    logInfo({ ct, bytes: buf.length, headHex }, 'tts ← not WAV');
    throw new Error(`Expected WAV bytes but got ct=${ct || 'unknown'} headHex=${headHex}`);
  }

  logInfo({ status: r.status, ct, bytes: buf.length }, 'tts ← ok (wav)');
  return buf;
}
