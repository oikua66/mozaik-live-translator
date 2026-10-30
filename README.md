# Mozaik Live Translator

Freestyle submission prototype for the JigJoy / NTP Novi Sad AI Hackathon 2026.

## Idea

**Speak once. The agents work while you are still talking.**

The target product is a one-page live translator for English, Serbian, Ukrainian and Russian. Speech is segmented into meaningful fragments. While the user continues speaking, different fragments move concurrently through a Mozaik pipeline:

1. **Input Agent** publishes recognized source fragments into shared runtime state.
2. **Translator Agent** translates the next available fragment.
3. **Editor Agent** polishes an earlier translated fragment using nearby context.
4. Later MVP stages add microphone/STT and pause-aware TTS.

The important behavior is pipeline concurrency: while the Translator Agent works on fragment N+1, the Editor Agent can work on fragment N.

## Current milestone: MVP-1A

This first competition commit intentionally starts with text fragments, not audio. It validates the Mozaik architecture before adding microphone/STT/TTS complexity.

### Run

Requirements:
- Node.js 24+
- npm
- `OPENAI_API_KEY` exported in your shell

```bash
npm install
npm run demo
```

For Mozaik Cloud observability, pair the machine/project using the official JigJoy Cloud SDK before running the demo.

## Architecture

```text
source.fragment
      ↓
 [Input Agent]
      ↓ fragment.ready
 [Translator Agent] ── model inference
      ↓ translation.ready
 [Editor Agent] ───── model inference
      ↓ output.ready
```

All three participants share a single Mozaik `RuntimeState` containing fragment status and work queues.

## Hackathon scope

Next steps after this text pipeline is verified:

- browser UI
- microphone capture
- speech-to-text segmentation
- language selector
- live original/translated panes
- visible agent status
- pause-aware TTS

No user accounts, billing, database, or production infrastructure are planned for the hackathon MVP.
