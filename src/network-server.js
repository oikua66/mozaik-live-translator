import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "@mozaik-ai/core";
import { CorporateNetworkState, initializeRuntime, join, resolveRuntime } from "./network-runtime.js";
import {
  createSysadminAgent,
  registerEmployee,
  removeEmployee,
  teardownModule,
  triggerEmployeeAction,
} from "./network-agents.js";

const PORT = Number(process.env.NETWORK_PORT || 3001);
const root = fileURLToPath(new URL("../public-network/", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

initializeRuntime({ state: new CorporateNetworkState() });

const controller = createAgent({
  name: "Network Demo Controller",
  capabilities: ["inference"],
  instruction: "Emit deterministic demo events only.",
  tools: [],
  handlers: [],
});
join(controller);

const sysadminAgent = createSysadminAgent();
join(sysadminAgent);
resolveRuntime().state.log("system.start", "Sysadmin Agent is monitoring the corporate network", {
  agentId: sysadminAgent.getId(),
});

const initialEmployees = [
  {
    id: "bvi-james",
    name: "James",
    office: "BVI Head Office",
    language: "English",
    role: "Operations Director",
    sampleText: "Please send the revised contract to Kyiv before 4 PM and confirm when it is received.",
  },
  {
    id: "kyiv-olena",
    name: "Olena",
    office: "Kyiv Office",
    language: "Ukrainian",
    role: "Project Manager",
    sampleText: "Будь ласка, перевірте останню версію договору і повідомте, чи можемо ми підписати його сьогодні.",
  },
  {
    id: "novi-sad-marko",
    name: "Marko",
    office: "Novi Sad Office",
    language: "Serbian",
    role: "Engineer",
    sampleText: "Molim vas proverite tehničku specifikaciju i javite da li možemo da počnemo u ponedeljak.",
  },
];
const fourthEmployee = {
  id: "tel-aviv-sarah",
  name: "Sarah",
  office: "Tel Aviv Office",
  language: "Hebrew",
  role: "Legal Counsel",
  sampleText: "בבקשה בדקו את הנוסח האחרון ואשרו אם אפשר לשלוח אותו ללקוח היום.",
};
for (const profile of initialEmployees) registerEmployee(profile);

let scenario = { running: false, step: "idle", startedAt: null, completedAt: null };

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
  const employees = [...state.employees.values()].map((employee) => {
    const record = state.personalAgents.get(employee.id);
    return {
      ...employee,
      agentId: record?.agent?.getId?.() || null,
      joinedAt: record?.joinedAt || null,
    };
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
  const state = resolveRuntime().state;
  for (const moduleId of [...state.activeModules.keys()]) teardownModule(moduleId);
  removeEmployee(fourthEmployee.id);
  for (const profile of initialEmployees) registerEmployee(profile);
}

async function runElasticScenario() {
  if (scenario.running) return;
  scenario = { running: true, step: "reset", startedAt: Date.now(), completedAt: null };
  await resetDemoTopology();

  const state = resolveRuntime().state;
  state.log("scenario.start", "Elastic workforce demo started");
  await sleep(600);

  scenario.step = "james-request";
  triggerEmployeeAction(controller, "bvi-james");
  await sleep(2200);

  scenario.step = "olena-request";
  triggerEmployeeAction(controller, "kyiv-olena");
  await sleep(2200);

  scenario.step = "marko-request";
  triggerEmployeeAction(controller, "novi-sad-marko");
  await sleep(9500);

  scenario.step = "fourth-employee-joins";
  registerEmployee(fourthEmployee);
  state.log("scenario.join", "A fourth office came online: Sarah joined from Tel Aviv");
  await sleep(1800);

  scenario.step = "two-employees-leave";
  removeEmployee("bvi-james");
  await sleep(700);
  removeEmployee("novi-sad-marko");
  state.log("scenario.leave", "Two employee agents left; capacity contracted automatically");
  await sleep(700);

  scenario = { running: false, step: "complete", startedAt: scenario.startedAt, completedAt: Date.now() };
  state.log("scenario.complete", "Elastic workforce demo completed");
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
    if (req.method === "GET" && req.url === "/api/state") return json(res, 200, snapshot());

    if (req.method === "POST" && req.url === "/api/action") {
      const body = await readJson(req);
      const employeeId = String(body.employeeId || "");
      const state = resolveRuntime().state;
      if (!state.personalAgents.has(employeeId)) return json(res, 404, { error: "Employee agent is not active." });
      triggerEmployeeAction(controller, employeeId, body.text ? String(body.text) : null);
      return json(res, 202, snapshot());
    }

    if (req.method === "POST" && req.url === "/api/scenario/run") {
      if (scenario.running) return json(res, 409, { error: "Scenario is already running." });
      runElasticScenario().catch((error) => {
        console.error("Scenario failed:", error);
        resolveRuntime().state.log("scenario.error", error?.message || "Scenario failed");
        scenario = { ...scenario, running: false, step: "error", completedAt: Date.now() };
      });
      return json(res, 202, snapshot());
    }

    if (req.method === "POST" && req.url === "/api/employee/add") {
      const body = await readJson(req);
      const profile = {
        id: String(body.id || `employee-${Date.now()}`),
        name: String(body.name || "Sarah"),
        office: String(body.office || "Tel Aviv Office"),
        language: String(body.language || "Hebrew"),
        role: String(body.role || "Legal Counsel"),
        sampleText: String(body.sampleText || "Please confirm the latest version."),
      };
      registerEmployee(profile);
      return json(res, 201, snapshot());
    }

    if (req.method === "POST" && req.url === "/api/employee/remove") {
      const body = await readJson(req);
      const employeeId = String(body.employeeId || "");
      if (!removeEmployee(employeeId)) return json(res, 404, { error: "Employee agent is not active." });
      return json(res, 200, snapshot());
    }

    if (req.method === "POST" && req.url === "/api/scenario/join-fourth") {
      registerEmployee(fourthEmployee);
      return json(res, 201, snapshot());
    }

    if (req.method === "POST" && req.url === "/api/scenario/two-leave") {
      removeEmployee("bvi-james");
      removeEmployee("novi-sad-marko");
      return json(res, 200, snapshot());
    }

    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error?.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  const mode = process.env.OPENAI_API_KEY && process.env.NETWORK_LLM !== "0" ? "real LLM" : "fallback";
  console.log(`\n🏢 Corporate Agent Network demo: http://localhost:${PORT}`);
  console.log(`Communication Module mode: ${mode}`);
  console.log("Existing translator remains unchanged at npm run web / port 3000.\n");
});
