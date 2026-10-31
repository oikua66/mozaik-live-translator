import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, SemanticEvent } from "@mozaik-ai/core";

import {
  CorporateNetworkState,
  initializeRuntime as initializeNetworkRuntime,
  join as joinNetwork,
  resolveRuntime as resolveNetworkRuntime,
} from "./network-runtime.js";
import {
  createSysadminAgent,
  registerEmployee,
  removeEmployee,
  teardownModule,
  triggerEmployeeAction,
} from "./network-agents.js";

import {
  initializeRuntime as initializeVoiceRuntime,
  join as joinVoice,
  resolveRuntime as resolveVoiceRuntime,
  sendEvent as sendVoiceEvent,
} from "./runtime.js";
import { TranslatorState } from "./runtime.js";
import { inputAgent, translatorAgent, editorAgent, voiceWriterAgent } from "./agents.js";

const PORT = Number(process.env.SHOWCASE3_PORT || 3002);
const root = fileURLToPath(new URL("../public-showcase3/", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
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

initializeNetworkRuntime({ state: new CorporateNetworkState() });

const networkController = createAgent({
  name: "Unified Demo Controller",
  capabilities: ["inference"],
  instruction: "Emit deterministic demo events only.",
  tools: [],
  handlers: [],
});
joinNetwork(networkController);

const sysadminAgent = createSysadminAgent();
joinNetwork(sysadminAgent);
resolveNetworkRuntime().state.log("system.start", "Sysadmin Agent is monitoring the unified corporate network", {
  agentId: sysadminAgent.getId(),
});

const initialEmployees = [
  {
    id: "bvi-james",
    name: "James",
    office: "BVI Head Office",
    language: "English",
    role: "Operations Director",
    voicePreference: "male",
    sampleText: "Please send the revised contract to Kyiv before 4 PM and confirm when it is received.",
  },
  {
    id: "kyiv-olena",
    name: "Olena",
    office: "Kyiv Office",
    language: "Ukrainian",
    role: "Project Manager",
    voicePreference: "female",
    sampleText: "Будь ласка, перевірте останню версію договору і повідомте, чи можемо ми підписати його сьогодні.",
  },
  {
    id: "novi-sad-marko",
    name: "Marko",
    office: "Novi Sad Office",
    language: "Serbian",
    role: "Engineer",
    voicePreference: "male",
    sampleText: "Molim vas proverite tehničku specifikaciju i javite da li možemo da počnemo u ponedeljak.",
  },
];
const fourthEmployee = {
  id: "tel-aviv-sarah",
  name: "Sarah",
  office: "Tel Aviv Office",
  language: "Hebrew",
  role: "Legal Counsel",
  voicePreference: "female",
  sampleText: "בבקשה בדקו את הנוסח האחרון ואשרו אם אפשר לשלוח אותו ללקוח היום.",
};
for (const profile of initialEmployees) registerEmployee(profile);

let scenario = { running: false, step: "idle", startedAt: null, completedAt: null };

function networkSnapshot() {
  const state = resolveNetworkRuntime().state;
  const employees = [...state.employees.values()].map((employee) => {
    const record = state.personalAgents.get(employee.id);
    return { ...employee, agentId: record?.agent?.getId?.() || null, joinedAt: record?.joinedAt || null };
  });
  const modules = [...state.activeModules.values()].map((module) => ({
    id: module.id,
    type: module.type,
    mode: module.mode,
    requestedBy: module.requestedBy,
    createdAt: module.createdAt,
    lastRequestedAt: module.lastRequestedAt,
    requestCount: module.requestCount || 0,
    status: module.status,
    members: module.members.map((member) => ({
      agentId: member.agentId,
      role: member.role,
      status: member.status,
      busy: Boolean(member.busy),
      queued: member.queue.length,
      startedAt: member.startedAt || null,
      completedAt: member.completedAt || null,
      phase: member.currentWork?.phase || null,
    })),
    requests: module.requests.map((request) => ({
      requestId: request.requestId,
      requestedBy: request.requestedBy,
      requestedByName: request.requestedByName,
      sourceLanguage: request.sourceLanguage,
      corporateLanguage: request.corporateLanguage,
      text: request.text,
      createdAt: request.createdAt,
      analyses: request.analyses || {},
      results: request.results,
    })),
  }));
  const participants = state.getParticipants().map((participant) => ({
    id: participant.getId(),
    name: participant.getManifest()?.name || participant.getManifest()?.role || "participant",
    role: participant.getManifest()?.role || null,
  }));
  return {
    sysadmin: { id: sysadminAgent.getId(), name: "Sysadmin Agent", status: "monitoring" },
    scenario,
    employees,
    modules,
    activePersonalAgents: state.personalAgents.size,
    activeSpecialistAgents: modules.reduce((sum, module) => sum + module.members.length, 0),
    activeAgents: 1 + state.personalAgents.size + modules.reduce((sum, module) => sum + module.members.length, 0),
    participants,
    eventLog: [...state.eventLog].slice(-80).reverse(),
  };
}

async function resetDemoTopology() {
  const state = resolveNetworkRuntime().state;
  for (const moduleId of [...state.activeModules.keys()]) teardownModule(moduleId);
  removeEmployee(fourthEmployee.id);
  for (const profile of initialEmployees) registerEmployee(profile);
}

async function waitForCommunicationIdle(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = resolveNetworkRuntime().state;
    const module = [...state.activeModules.values()].find((item) => item.type === "Communication Module");
    if (!module) return true;
    if (!module.members.some((member) => member.busy || member.queue.length)) return true;
    await sleep(150);
  }
  return false;
}

async function waitForCommunicationRelease(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = resolveNetworkRuntime().state;
    const module = [...state.activeModules.values()].find((item) => item.type === "Communication Module");
    if (!module) return true;
    await sleep(150);
  }
  return false;
}

async function runElasticScenario() {
  if (scenario.running) return;
  scenario = { running: true, step: "reset", startedAt: Date.now(), completedAt: null };
  await resetDemoTopology();
  const state = resolveNetworkRuntime().state;
  state.log("scenario.start", "Elastic workforce demo started");
  await sleep(600);
  scenario.step = "live-communication-request";
  triggerEmployeeAction(networkController, "novi-sad-marko");
  scenario.step = "waiting-for-coordination";
  if (!(await waitForCommunicationIdle())) state.log("scenario.timeout", "Communication Module did not become idle before timeout");
  scenario.step = "waiting-for-release";
  if (!(await waitForCommunicationRelease())) {
    state.log("scenario.timeout", "Communication Module did not release before timeout; forcing release");
    for (const moduleId of [...state.activeModules.keys()]) teardownModule(moduleId);
    await sleep(500);
  }
  scenario.step = "module-released";
  await sleep(1400);
  scenario.step = "fourth-employee-joins";
  registerEmployee(fourthEmployee);
  state.log("scenario.join", "A fourth office came online: Sarah joined from Tel Aviv");
  await sleep(1400);
  scenario.step = "first-employee-leaves";
  removeEmployee("bvi-james");
  state.log("scenario.leave", "James Personal Agent left; capacity contracted automatically");
  await sleep(1400);
  scenario.step = "second-employee-leaves";
  removeEmployee("novi-sad-marko");
  state.log("scenario.leave", "Marko Personal Agent left; capacity contracted automatically");
  await sleep(1400);
  scenario = { running: false, step: "complete", startedAt: scenario.startedAt, completedAt: Date.now() };
  state.log("scenario.complete", "Elastic workforce demo completed");
}

initializeVoiceRuntime({
  state: new TranslatorState({ sourceLanguage: "ru", targetLanguage: "en", outputStyle: "polite" }),
});
joinVoice(inputAgent);
joinVoice(translatorAgent);
joinVoice(editorAgent);
joinVoice(voiceWriterAgent);

let nextFragmentId = 1;
const speechCache = new Map();

function voiceSnapshot() {
  const state = resolveVoiceRuntime().state;
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

function resetVoiceState({ sourceLanguage, targetLanguage, outputStyle }) {
  const state = resolveVoiceRuntime().state;
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

function normalizeVoicePreference(value) {
  return ["female", "male", "neutral"].includes(value) ? value : "auto";
}

function speechProfile(preference) {
  const pref = normalizeVoicePreference(preference);
  if (pref === "female") return {
    voice: "marin",
    instructions: "Speak in a warm, professional feminine presentation. Natural conversational pace, clear pronunciation, no theatrical delivery.",
  };
  if (pref === "male") return {
    voice: "cedar",
    instructions: "Speak in a calm, professional masculine presentation. Natural conversational pace, clear pronunciation, no theatrical delivery.",
  };
  if (pref === "neutral") return {
    voice: "alloy",
    instructions: "Speak in a neutral professional presentation. Natural conversational pace, clear pronunciation, no theatrical delivery.",
  };
  return {
    voice: "marin",
    instructions: "Speak naturally and professionally at a relaxed conversational pace with clear pronunciation.",
  };
}

async function createSpeech(text, preference = "auto") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const profile = speechProfile(preference);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts-2025-12-15",
      voice: profile.voice,
      instructions: profile.instructions,
      input: text,
      response_format: "mp3",
      speed: 0.9,
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`TTS API ${response.status}: ${details.slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function cachedSpeech(text, preference = "auto") {
  const pref = normalizeVoicePreference(preference);
  const key = `${pref}\n${text}`;
  let audio = speechCache.get(key);
  if (!audio) {
    audio = await createSpeech(text, pref);
    speechCache.set(key, audio);
    if (speechCache.size > 50) speechCache.delete(speechCache.keys().next().value);
  }
  return audio;
}

function sendAudio(res, audio, disposition = "inline") {
  res.writeHead(200, {
    "content-type": "audio/mpeg",
    "content-disposition": disposition,
    "content-length": audio.length,
    "cache-control": "no-store",
  });
  res.end(audio);
}

async function handleNetworkApi(req, res, path) {
  if (req.method === "GET" && path === "/state") return json(res, 200, networkSnapshot());
  if (req.method === "POST" && path === "/action") {
    const body = await readJson(req);
    const employeeId = String(body.employeeId || "");
    const state = resolveNetworkRuntime().state;
    if (!state.personalAgents.has(employeeId)) return json(res, 404, { error: "Employee agent is not active." });
    triggerEmployeeAction(networkController, employeeId, body.text ? String(body.text) : null);
    return json(res, 202, networkSnapshot());
  }
  if (req.method === "POST" && path === "/scenario/run") {
    if (scenario.running) return json(res, 409, { error: "Scenario is already running." });
    runElasticScenario().catch((error) => {
      console.error("Scenario failed:", error);
      resolveNetworkRuntime().state.log("scenario.error", error?.message || "Scenario failed");
      scenario = { ...scenario, running: false, step: "error", completedAt: Date.now() };
    });
    return json(res, 202, networkSnapshot());
  }
  if (req.method === "POST" && path === "/scenario/join-fourth") {
    registerEmployee(fourthEmployee);
    return json(res, 201, networkSnapshot());
  }
  if (req.method === "POST" && path === "/scenario/two-leave") {
    removeEmployee("bvi-james");
    removeEmployee("novi-sad-marko");
    return json(res, 200, networkSnapshot());
  }
  return json(res, 404, { error: "Unknown network API route." });
}

async function handleVoiceApi(req, res, path) {
  if (req.method === "GET" && path === "/state") return json(res, 200, voiceSnapshot());
  if (req.method === "POST" && path === "/config") {
    const body = await readJson(req);
    const state = resolveVoiceRuntime().state;
    if (state.sourceBusy || state.translationBusy || state.editBusy || state.voiceBusy) {
      return json(res, 409, { error: "Agents are busy. Stop speaking and wait before changing settings." });
    }
    state.sourceLanguage = body.sourceLanguage || state.sourceLanguage;
    state.targetLanguage = body.targetLanguage || state.targetLanguage;
    state.outputStyle = body.outputStyle || state.outputStyle;
    return json(res, 200, voiceSnapshot());
  }
  if (req.method === "POST" && path === "/fragment") {
    const body = await readJson(req);
    const text = String(body.text || "").trim();
    if (!text) return json(res, 400, { error: "text is required" });
    const id = nextFragmentId++;
    const serverReceivedAt = Date.now();
    const clientFinalAt = Number(body.clientFinalAt || 0) || null;
    console.log(`⏱ voice #${id} speech-final → unified server: ${clientFinalAt ? serverReceivedAt - clientFinalAt : "n/a"} ms`);
    const event = SemanticEvent.create("source.fragment", inputAgent.getId(), { id, text, clientFinalAt, serverReceivedAt });
    sendVoiceEvent(event, inputAgent.getId());
    return json(res, 202, { id });
  }
  if (req.method === "POST" && path === "/clear") {
    const body = await readJson(req);
    if (!resetVoiceState(body)) return json(res, 409, { error: "Agents are still processing." });
    return json(res, 200, voiceSnapshot());
  }
  if (req.method === "POST" && (path === "/speech" || path === "/save-voice")) {
    const body = await readJson(req);
    const text = String(body.text || "").trim();
    if (!text) return json(res, 400, { error: "No voice script to speak." });
    if (text.length > 4096) return json(res, 400, { error: "Voice script is too long for one audio file." });
    const preference = normalizeVoicePreference(String(body.voicePreference || "auto"));
    const audio = await cachedSpeech(text, preference);
    if (path === "/save-voice") {
      return sendAudio(res, audio, `attachment; filename=translator-voice-${preference}.mp3`);
    }
    return sendAudio(res, audio, "inline");
  }
  return json(res, 404, { error: "Unknown voice API route." });
}

async function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = requestPath.split("?")[0].replace(/\.\./g, "");
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
    const url = req.url || "/";
    if (url.startsWith("/network-api/")) {
      const path = url.slice("/network-api".length).split("?")[0];
      return handleNetworkApi(req, res, path);
    }
    if (url.startsWith("/voice-api/")) {
      const path = url.slice("/voice-api".length).split("?")[0];
      return handleVoiceApi(req, res, path);
    }
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error?.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  const mode = process.env.OPENAI_API_KEY && process.env.NETWORK_LLM !== "0" ? "real LLM" : "fallback";
  console.log(`\n🏢 Unified Corporate Agent Product: http://localhost:${PORT}`);
  console.log(`Network module: ${mode}`);
  console.log("Live voice module: browser speech recognition + OpenAI AI TTS.");
  console.log("Backup products remain untouched: npm run web / npm run network-demo.\n");
});
