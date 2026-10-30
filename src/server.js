import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticEvent } from "@mozaik-ai/core";
import { initializeRuntime, join, resolveRuntime, sendEvent } from "./runtime.js";
import { TranslatorState } from "./runtime.js";
import { inputAgent, translatorAgent, editorAgent } from "./agents.js";

const PORT = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL("../public/", import.meta.url));

initializeRuntime({
  state: new TranslatorState({ sourceLanguage: "ru", targetLanguage: "en" }),
});
join(inputAgent);
join(translatorAgent);
join(editorAgent);

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
    sourceBusy: state.sourceBusy,
    translationBusy: state.translationBusy,
    editBusy: state.editBusy,
    sourceQueueLength: state.sourceQueue.length,
    translationQueueLength: state.translationQueue.length,
    editQueueLength: state.editQueue.length,
    fragments: [...state.fragments.values()].sort((a, b) => a.id - b.id),
  };
}

function resetState({ sourceLanguage, targetLanguage }) {
  const state = resolveRuntime().state;
  if (state.sourceBusy || state.translationBusy || state.editBusy) return false;
  state.sourceLanguage = sourceLanguage || state.sourceLanguage;
  state.targetLanguage = targetLanguage || state.targetLanguage;
  state.fragments.clear();
  state.sourceQueue.length = 0;
  state.translationQueue.length = 0;
  state.editQueue.length = 0;
  state.activeSourceFragmentId = null;
  state.activeTranslationFragmentId = null;
  state.activeEditFragmentId = null;
  nextFragmentId = 1;
  return true;
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
      if (state.sourceBusy || state.translationBusy || state.editBusy) {
        return json(res, 409, { error: "Agents are busy. Stop speaking and wait before changing languages." });
      }
      state.sourceLanguage = body.sourceLanguage || state.sourceLanguage;
      state.targetLanguage = body.targetLanguage || state.targetLanguage;
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
  console.log("Speak in the browser; Mozaik agents process each final speech fragment.\n");
});
