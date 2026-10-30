import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticEvent } from "@mozaik-ai/core";
import { initializeRuntime, join, resolveRuntime, sendEvent } from "./runtime.js";
import { TranslatorState } from "./runtime.js";
import { inputAgent, translatorAgent, editorAgent, voiceWriterAgent } from "./agents.js";

const PORT = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL("../public/", import.meta.url));

initializeRuntime({
  state: new TranslatorState({ sourceLanguage: "ru", targetLanguage: "en", outputStyle: "polite" }),
});
join(inputAgent);
join(translatorAgent);
join(editorAgent);
join(voiceWriterAgent);

let nextFragmentId = 1;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function snapshot() {
  const state = resolveRuntime().state;
  return {
    sourceLanguage: state.sourceLanguage,
    targetLanguage: state.targetLanguage,
    outputStyle: state.outputStyle,
    sourceBusy: state.sourceBusy,
    translationBusy: state.translationBusy,
    editBusy: state.editBusy,
    voiceBusy: state.voiceBusy,
    sourceQueueLength: state.sourceQueue.length,
    translationQueueLength: state.translationQueue.length,
    editQueueLength: state.editQueue.length,
    voiceQueueLength: state.voiceQueue.length,
    fragments: [...state.fragments.values()].sort((a, b) => a.id - b.id),
  };
}

function resetState({ sourceLanguage, targetLanguage, outputStyle }) {
  const state = resolveRuntime().state;
  if (state.sourceBusy || state.translationBusy || state.editBusy || state.voiceBusy) return false;
  state.sourceLanguage = sourceLanguage || state.sourceLanguage;
  state.targetLanguage = targetLanguage || state.targetLanguage;
  state.outputStyle = outputStyle || state.outputStyle;
  state.fragments.clear();
  state.sourceQueue.length = 0;
  state.translationQueue.length = 0;
  state.editQueue.length = 0;
  state.voiceQueue.length = 0;
  state.activeSourceFragmentId = null;
  state.activeTranslationFragmentId = null;
  state.activeEditTask = null;
  state.activeVoiceTask = null;
  nextFragmentId = 1;
  return true;
}

async function createSpeech(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts-2025-12-15",
      voice: "marin",
      input: text,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TTS API ${response.status}: ${details.slice(0, 300)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function serveStatic(req, res) {
  const path = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.split("?")[0].replace(/\.\./g, "");
  try {
    const data = await readFile(pathJoin(root, safePath));
    res.writeHead(200, { "content-type": mime[extname(safePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/state") {
      return json(res, 200, snapshot());
    }

    if (req.method === "POST" && req.url === "/api/config") {
      const body = await readJson(req);
      const state = resolveRuntime().state;
      if (state.sourceBusy || state.translationBusy || state.editBusy || state.voiceBusy) {
        return json(res, 409, { error: "Agents are busy. Stop speaking and wait before changing settings." });
      }
      state.sourceLanguage = body.sourceLanguage || state.sourceLanguage;
      state.targetLanguage = body.targetLanguage || state.targetLanguage;
      state.outputStyle = body.outputStyle || state.outputStyle;
      return json(res, 200, snapshot());
    }

    if (req.method === "POST" && req.url === "/api/fragment") {
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "text is required" });

      const id = nextFragmentId++;
      const serverReceivedAt = Date.now();
      const clientFinalAt = Number(body.clientFinalAt || 0) || null;
      const browserToServerMs = clientFinalAt ? serverReceivedAt - clientFinalAt : null;
      console.log(`⏱ #${id} speech-final → server: ${browserToServerMs ?? "n/a"} ms`);

      const event = SemanticEvent.create("source.fragment", inputAgent.getId(), {
        id,
        text,
        clientFinalAt,
        serverReceivedAt,
      });
      sendEvent(event, inputAgent.getId());
      return json(res, 202, { id });
    }

    if (req.method === "POST" && req.url === "/api/save-voice") {
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "No voice script to save." });
      if (text.length > 4096) return json(res, 400, { error: "Voice script is too long for one audio file." });

      const audio = await createSpeech(text);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-disposition": `attachment; filename=translator-voice-${stamp}.mp3`,
        "content-length": audio.length,
        "cache-control": "no-store",
      });
      return res.end(audio);
    }

    if (req.method === "POST" && req.url === "/api/clear") {
      const body = await readJson(req);
      if (!resetState(body)) return json(res, 409, { error: "Agents are still processing." });
      return json(res, 200, snapshot());
    }

    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error?.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`\n🌐 Live Translator UI: http://localhost:${PORT}`);
  console.log("Speak in the browser; four Mozaik agents process each final speech fragment.\n");
});
