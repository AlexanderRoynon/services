import Fastify from 'fastify';
import formBody from '@fastify/formbody';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream';
import util from 'util';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { chatReply, synthesizeWavStrict } from './openai.js';
import { validateTwilioSignature, redirectCallToPlay } from './twilio.js';
import { saveWav, ensureAudioDir, hasGreeting, saveGreeting } from './storage.js';

const pump = util.promisify(pipeline);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true });
await app.register(formBody);

const cfg = loadConfig();
ensureAudioDir();

console.log(`[voice-agent] listening on :${cfg.env.port || 3000} (final transcripts only)`);

function absoluteUrl(host, rel) {
  return `https://${host}${rel.startsWith('/') ? '' : '/'}${rel}`;
}
function escapeXml(s = '') {
  return s.replace(/[<>&'"]/g, ch =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' :
    ch === '"' ? '&quot;' : '&apos;'
  );
}
const log = (obj, msg) => { try { app.log.info(obj || {}, msg); } catch {} };

/** Ensure greeting.wav exists (strict WAV), return its absolute URL */
async function ensureGreetingWav(host) {
  if (!hasGreeting()) {
    const text = cfg.env.greeting || 'Hello! How can I help?';
    log({ model: cfg.env.openai.ttsModel, voice: cfg.env.openai.voice }, 'greeting missing → TTS');
    const wavBuf = await synthesizeWavStrict({
      apiKey: cfg.env.openai.apiKey,
      text,
      model: cfg.env.openai.ttsModel || 'gpt-4o-mini-tts',
      voice: cfg.env.openai.voice || 'coral'
    });
    saveGreeting(wavBuf);
    log({}, 'greeting.wav created');
  }
  return absoluteUrl(host, '/audio/greeting.wav');
}

// Track which CallSids already got the greeting so it doesn't replay after redirects/updates
const greeted = new Set();

// ---------- Health ----------
app.get('/health', async (_, reply) => {
  return reply.send({ ok: true, service: 'voice-agent' });
});

// ---------- Explicit WAV route with Range + HEAD support ----------
app.route({
  method: ['GET', 'HEAD'],
  url: '/audio/:file',
  handler: async (req, reply) => {
    try {
      const { file } = req.params;
      if (!file || !file.endsWith('.wav') || file.includes('..')) {
        return reply.code(400).type('text/plain').send('Bad request');
      }
      const full = path.resolve(__dirname, '..', 'audio', file); // /app/audio/<file>
      if (!fs.existsSync(full)) {
        return reply.code(404).type('text/plain').send('Not found');
      }

      const stat = fs.statSync(full);
      const total = stat.size;
      const isHead = req.raw.method === 'HEAD';
      const range = req.headers.range;

      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'public, max-age=0');
      reply.header('Content-Type', 'audio/wav');

      if (isHead) {
        reply.header('Content-Length', total);
        return reply.code(200).send();
      }

      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : total - 1;
          if (isNaN(start) || isNaN(end) || start > end || end >= total) {
            reply.code(416);
            reply.header('Content-Range', `bytes */${total}`);
            return reply.send();
          }
          const chunk = fs.createReadStream(full, { start, end });
          reply.code(206);
          reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
          reply.header('Content-Length', end - start + 1);
          return pump(chunk, reply.raw);
        }
      }

      reply.header('Content-Length', total);
      const rs = fs.createReadStream(full);
      return pump(rs, reply.raw);
    } catch (e) {
      req.log?.error(e, 'error serving wav');
      return reply.code(500).type('text/plain').send('Server error');
    }
  }
});

// ---------- Helper to build Transcription attrs (finals only) ----------
function buildTranscriptionAttrs(callbackUrl) {
  return `statusCallbackUrl="${escapeXml(callbackUrl)}"
          languageCode="${escapeXml(cfg.language || 'en-US')}"
          track="inbound_track"
          transcriptionEngine="google"
          partialResults="false"`;
}

// ---------- Incoming Call (or resume): Start Transcription; Play greeting only once ----------
app.post('/twilio/voice', async (req, reply) => {
  try {
    if (cfg.env.twilio.validateSignature) {
      const url = absoluteUrl(cfg.env.host, req.raw.url);
      const valid = validateTwilioSignature({
        enabled: true,
        authToken: cfg.env.twilio.authToken,
        url,
        headers: req.headers,
        body: req.body
      });
      if (!valid) {
        log({}, 'twilio signature invalid on /twilio/voice');
        return reply.code(403).type('text/plain').send('Invalid Twilio signature');
      }
    }

    const callSid = (req.body?.CallSid || req.body?.callSid || '').toString();
    const transcriptionCallback = absoluteUrl(cfg.env.host, '/twilio/transcription');
    const transcriptionAttrs = buildTranscriptionAttrs(transcriptionCallback);

    // If we haven't greeted this CallSid yet, play greeting once.
    const shouldPlayGreeting = callSid && !greeted.has(callSid);
    if (shouldPlayGreeting) greeted.add(callSid);

    let greetingBlock = '';
    if (shouldPlayGreeting) {
      try {
        const greetingUrl = await ensureGreetingWav(cfg.env.host);
        greetingBlock = `<Play>${escapeXml(greetingUrl)}</Play>`;
      } catch (e) {
        app.log.error(e, 'Failed to create greeting.wav, falling back to <Say>');
        greetingBlock = `<Say>${escapeXml(cfg.env.greeting || 'Hello! How can I help?')}</Say>`;
      }
    }

    // TwiML: optional greeting (first time only), then start transcription and park the call
    const twiml = `
      <Response>
        ${greetingBlock}
        <Start>
          <Transcription ${transcriptionAttrs} />
        </Start>
        <Pause length="60"/>
      </Response>
    `.trim();

    reply.type('text/xml').send(twiml);
  } catch (err) {
    app.log.error(err, 'error in /twilio/voice');
    reply.code(500).type('text/plain').send('Server error');
  }
});

// ---------- Explicit "resume" endpoint: no greeting, restart transcription ----------
app.post('/twilio/resume', async (req, reply) => {
  try {
    if (cfg.env.twilio.validateSignature) {
      const url = absoluteUrl(cfg.env.host, req.raw.url);
      const valid = validateTwilioSignature({
        enabled: true,
        authToken: cfg.env.twilio.authToken,
        url,
        headers: req.headers,
        body: req.body
      });
      if (!valid) {
        log({}, 'twilio signature invalid on /twilio/resume');
        return reply.code(403).type('text/plain').send('Invalid Twilio signature');
      }
    }
    const transcriptionCallback = absoluteUrl(cfg.env.host, '/twilio/transcription');
    const transcriptionAttrs = buildTranscriptionAttrs(transcriptionCallback);

    const twiml = `
      <Response>
        <Start>
          <Transcription ${transcriptionAttrs} />
        </Start>
        <Pause length="60"/>
      </Response>
    `.trim();

    reply.type('text/xml').send(twiml);
  } catch (err) {
    app.log.error(err, 'error in /twilio/resume');
    reply.code(500).type('text/plain').send('Server error');
  }
});

// ---------- Real-time Transcription handling (FINAL-ONLY) ----------
function pick(body, ...keys) {
  for (const k of keys) {
    if (body[k] != null) return String(body[k]);
  }
  return '';
}

function parseTranscriptionData(body) {
  // Twilio sends TranscriptionEvent=transcription-content and TranscriptionData is a JSON string
  // with a "transcript" (or "Transcript") field.
  const td = pick(body, 'TranscriptionData', 'transcriptionData');
  if (td) {
    try {
      const obj = JSON.parse(td);
      return (obj.transcript || obj.Transcript || '').toString();
    } catch (_) {
      return '';
    }
  }
  // fallbacks for other payload shapes
  return (
    pick(body, 'TranscriptionText', 'SpeechResult', 'utterance', 'transcript', 'text') || ''
  ).toString();
}

function isFinalEvent(body) {
  // Twilio sets Final: "true"/"false" on transcription-content; also stop events, or explicit statuses.
  const finalFlag = pick(body, 'Final', 'final').toLowerCase();
  if (finalFlag === 'true') return true;
  const evt = pick(body, 'TranscriptionEvent', 'event', 'EventType').toLowerCase();
  if (evt.includes('stopped')) return true;
  const status = pick(body, 'TranscriptionStatus', 'Status').toLowerCase();
  if (status === 'completed' || status === 'final') return true;
  return false;
}

const recentByCall = new Map(); // de-dupe per CallSid (last text + ts)
function shouldProcess(callSid, text) {
  const now = Date.now();
  const prev = recentByCall.get(callSid);
  if (prev && prev.text === text && (now - prev.ts) < 5000) return false;
  recentByCall.set(callSid, { text, ts: now });
  return true;
}

async function finalizeUtterance({ callSid, text }) {
  if (!text?.trim()) return;
  if (!shouldProcess(callSid, text)) { log({ callSid }, 'duplicate final text dropped'); return; }

  log({ callSid, textLen: text.length }, 'final transcript → chat');

  // CHAT
  const assistantText = (await chatReply({
    apiKey: cfg.env.openai.apiKey,
    model: cfg.env.openai.chatModel, // gpt-4.1-mini
    system: cfg.system_prompt,
    user: text
  })).slice(0, cfg.max_response_chars || 600);

  log({ chars: assistantText.length }, 'chatReply ok');

  // TTS → strict WAV
  const wavBuf = await synthesizeWavStrict({
    apiKey: cfg.env.openai.apiKey,
    text: assistantText,
    model: cfg.env.openai.ttsModel,   // gpt-4o-mini-tts
    voice: cfg.env.openai.voice       // coral
  });

  log({ bytes: wavBuf.length }, 'tts ok (wav)');

  // Save and redirect live call to play the clip
  const { id } = saveWav(wavBuf);
  const playUrl = absoluteUrl(cfg.env.host, `/audio/${id}.wav`);

  // After playing, we want to keep the call in a state where transcription continues
  // WITHOUT replaying the greeting. Many implementations redirect back to the original
  // voice webhook; that replays the greeting. Instead, point to /twilio/resume.
  const resumeUrl = absoluteUrl(cfg.env.host, '/twilio/resume');

  await redirectCallToPlay({
    accountSid: cfg.env.twilio.accountSid,
    authToken:  cfg.env.twilio.authToken,
    callSid,
    audioUrl: playUrl,
    // If your helper supports it, pass resumeUrl so it issues:
    // <Response><Play>.../audio.wav</Play><Redirect>resumeUrl</Redirect></Response>
    // If it doesn't, it can ignore this param; in that case, if it still returns to /twilio/voice,
    // our greeted-set will prevent the greeting from playing again.
    resumeUrl
  });

  log({ callSid, playUrl, resumeUrl }, 'assistant reply generated and redirected');
}

app.post('/twilio/transcription', async (req, reply) => {
  // ACK immediately so Twilio doesn’t retry
  reply.code(204).send();

  try {
    if (cfg.env.twilio.validateSignature) {
      const url = absoluteUrl(cfg.env.host, req.raw.url);
      const ok = validateTwilioSignature({
        enabled: true,
        authToken: cfg.env.twilio.authToken,
        url,
        headers: req.headers,
        body: req.body
      });
      if (!ok) { log({}, 'Invalid Twilio signature on /twilio/transcription'); return; }
    }

    const callSid =
      req.body.CallSid || req.body.callSid || (Array.isArray(req.body.CallSid) ? req.body.CallSid[0] : null);

    const eventType = (req.body.TranscriptionEvent || '').toString();
    const text = parseTranscriptionData(req.body).trim();
    const isFinal = isFinalEvent(req.body);

    if (!callSid) { log({ eventType }, 'skip: no CallSid'); return; }

    // FINAL-ONLY: ignore everything that isn't explicitly final
    if (!isFinal) {
      log({ callSid, eventType }, 'non-final ignored');
      return;
    }

    // Final received — send to OpenAI
    log({ callSid, eventType }, 'explicit-final');

    if (!text) {
      log({ callSid }, 'final had no text — skipped');
      return;
    }

    await finalizeUtterance({ callSid, text });
  } catch (err) {
    app.log.error({ err: String(err) }, 'error in /twilio/transcription');
  }
});

// ---------- Debug helper: force-generate greeting.wav ----------
app.post('/debug/generate-greeting', async (req, reply) => {
  try {
    const url = await ensureGreetingWav(cfg.env.host);
    reply.send({ ok: true, url });
  } catch (e) {
    app.log.error(e, 'debug generate greeting failed');
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Debug helper: end-to-end chat + TTS without Twilio ----------
app.post('/debug/test-openai', async (req, reply) => {
  try {
    const user = (req.body && req.body.text) || 'This is a test of the voice agent.';
    const assistantText = await chatReply({
      apiKey: cfg.env.openai.apiKey,
      model: cfg.env.openai.chatModel,
      system: cfg.system_prompt,
      user
    });
    const wav = await synthesizeWavStrict({
      apiKey: cfg.env.openai.apiKey,
      text: assistantText,
      model: cfg.env.openai.ttsModel,
      voice: cfg.env.openai.voice
    });
    const { id } = saveWav(wav);
    const url = absoluteUrl(cfg.env.host, `/audio/${id}.wav`);
    reply.send({ ok: true, userChars: user.length, assistantChars: assistantText.length, bytes: wav.length, url });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Boot ----------
const port = cfg.env.port || 3000;
app.listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[voice-agent] listening on :${port}`))
  .catch((e) => { console.error(e); process.exit(1); });
