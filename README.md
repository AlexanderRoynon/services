# Voice Agent (Twilio Transcriptions + OpenAI Chat + TTS)

## Prereqs
- Domain pointed to your server (A/AAAA record), e.g. `voice.example.com`
- Docker + Docker Compose
- Twilio account/number
- OpenAI API key

## Configure
1. From `.env.template` create a `.env` and fill the values with your information.
1. From `config/.agent-config.yml.template` create a `config/agent-config.yml` and fill the values with your information.
3. Set your domain in `VOICE_AGENT_HOST`.

## Run
```bash
docker compose up -d --build
docker compose logs -f traefik
docker compose logs -f voice_agent

### Greeting behavior
- On first call, if `/audio/greeting.wav` is missing, the server generates it using OpenAI TTS
  with `OPENAI_TTS_MODEL` (default: gpt-4o-mini-realtime-preview) and `OPENAI_TTS_VOICE` (default: coral),
  speaking `GREETING_TEXT`. It saves the file for reuse.
- Each call plays `/audio/greeting.wav` **first**, then starts transcription, then listens.
