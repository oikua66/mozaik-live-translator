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
  triggerEmployeeAction,
} from "./network-agents.js";

const PORT = Number(process.env.NETWORK_PORT || 3001);
const root = fileURLToPath(new URL("../public-network/", import.meta.url));

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
  { id: "bvi-james", name: "James", office: "BVI Head Office", language: "English", role: "Operations Director" },
  { id: "kyiv-olena", name: "Olena", office: "Kyiv Office", language: "Ukrainian", role: "Project Manager" },
  { id: "novi-sad-marko", name: "Marko", office: "Novi Sad Office", language: "Serbian", role: "Engineer" },
];
for (const profile of initialEmployees) registerEmployee(profile);

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
    requestedBy: module.requestedBy,
    createdAt: module.createdAt,
    status: module.status,
    members: module.members,
  }));
  const participants = state.getParticipants().map((participant) => ({
    id: participant.getId(),
    name: participant.getManifest()?.name || participant.getManifest()?.role || "participant",
    role: participant.getManifest()?.role || null,
  }));
  return {
    sysadmin: { id: sysadminAgent.getId(), name: "Sysadmin Agent", status: "monitoring" },
    employees,
    modules,
    activePersonalAgents: state.personalAgents.size,
    activeSpecialistAgents: modules.reduce((sum, module) => sum + module.members.length, 0),
    activeAgents: participants.filter((item) => item.role === "agent").length,
    participants,
    eventLog: [...state.eventLog].slice(-80).reverse(),
  };
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
      triggerEmployeeAction(controller, employeeId);
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
      registerEmployee({
        id: "tel-aviv-sarah",
        name: "Sarah",
        office: "Tel Aviv Office",
        language: "Hebrew",
        role: "Legal Counsel",
      });
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
  console.log(`\n🏢 Corporate Agent Network demo: http://localhost:${PORT}`);
  console.log("Existing translator remains unchanged at npm run web / port 3000.\n");
});
