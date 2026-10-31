import { createAgent, SemanticEvent, SituationSpecification } from "@mozaik-ai/core";
import { join, leave, resolveRuntime, sendEvent } from "./network-runtime.js";

class EmployeeActionSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "employee.action"; }
}

class ModuleRequestedSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "module.requested"; }
}

class CommunicationWorkSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "communication.work"; }
}

function publish(type, producer, payload) {
  const event = SemanticEvent.create(type, producer.getId(), payload);
  sendEvent(event, producer.getId());
}

export function createEmployeeAgent(profile) {
  let agent;
  agent = createAgent({
    name: `${profile.name} Personal Agent`,
    capabilities: ["inference"],
    instruction: `You represent ${profile.name}, ${profile.role} in ${profile.office}. Preferred language: ${profile.language}.`,
    tools: [],
    handlers: [
      {
        specification: new EmployeeActionSpecification(),
        processor: {
          apply({ event }) {
            if (event.payload?.employeeId !== profile.id) return;
            const state = resolveRuntime().state;
            state.log("employee.action", `${profile.name} requested multilingual communication`, {
              employeeId: profile.id,
              agentId: agent.getId(),
              office: profile.office,
              language: profile.language,
            });
            publish("module.requested", agent, {
              moduleType: "communication",
              requestedBy: profile.id,
              sourceLanguage: profile.language,
              corporateLanguage: "English",
            });
          },
        },
      },
    ],
  });
  return agent;
}

function createModuleAgent({ name, moduleId, role }) {
  let agent;
  agent = createAgent({
    name,
    capabilities: ["inference"],
    instruction: `Temporary ${role} agent for corporate communication module ${moduleId}.`,
    tools: [],
    handlers: [
      {
        specification: new CommunicationWorkSpecification(),
        processor: {
          apply({ event }) {
            if (event.payload?.moduleId !== moduleId) return;
            const state = resolveRuntime().state;
            const module = state.activeModules.get(moduleId);
            if (!module) return;
            const member = module.members.find((item) => item.agentId === agent.getId());
            if (!member) return;
            member.status = "running";
            member.startedAt = Date.now();
            state.log("module.work", `${role} started`, { moduleId, agentId: agent.getId() });

            const delay = role === "Translator" ? 900 : role === "Editor" ? 1250 : 1600;
            setTimeout(() => {
              const live = resolveRuntime().state.activeModules.get(moduleId);
              if (!live) return;
              const current = live.members.find((item) => item.agentId === agent.getId());
              if (!current) return;
              current.status = "done";
              current.completedAt = Date.now();
              resolveRuntime().state.log("module.done", `${role} completed`, { moduleId, agentId: agent.getId() });
            }, delay);
          },
        },
      },
    ],
  });
  return agent;
}

export function createSysadminAgent() {
  let agent;
  agent = createAgent({
    name: "Sysadmin Agent",
    capabilities: ["inference"],
    instruction: "Monitor corporate agent capacity and instantiate temporary specialist modules when requested.",
    tools: [],
    handlers: [
      {
        specification: new ModuleRequestedSpecification(),
        processor: {
          apply({ event }) {
            if (event.payload?.moduleType !== "communication") return;
            spawnCommunicationModule(agent, event.payload);
          },
        },
      },
    ],
  });
  return agent;
}

export function registerEmployee(profile) {
  const state = resolveRuntime().state;
  if (state.personalAgents.has(profile.id)) return state.personalAgents.get(profile.id).agent;
  const agent = createEmployeeAgent(profile);
  join(agent);
  state.employees.set(profile.id, { ...profile, active: true });
  state.personalAgents.set(profile.id, { profile, agent, joinedAt: Date.now() });
  state.log("agent.join", `${profile.name} Personal Agent joined`, {
    employeeId: profile.id,
    agentId: agent.getId(),
    office: profile.office,
  });
  return agent;
}

export function removeEmployee(employeeId) {
  const state = resolveRuntime().state;
  const record = state.personalAgents.get(employeeId);
  if (!record) return false;
  leave(record.agent);
  state.personalAgents.delete(employeeId);
  const employee = state.employees.get(employeeId);
  if (employee) employee.active = false;
  state.log("agent.leave", `${record.profile.name} Personal Agent left`, {
    employeeId,
    agentId: record.agent.getId(),
  });
  return true;
}

export function spawnCommunicationModule(sysadmin, request = {}) {
  const state = resolveRuntime().state;
  const moduleId = `comm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const specs = [
    ["Translator Agent", "Translator"],
    ["Editor Agent", "Editor"],
    ["Voice Writer Agent", "Voice Writer"],
  ];
  const agents = specs.map(([name, role]) => createModuleAgent({ name: `${name} ${moduleId.slice(-4)}`, moduleId, role }));
  const module = {
    id: moduleId,
    type: "Communication Module",
    requestedBy: request.requestedBy || null,
    createdAt: Date.now(),
    status: "active",
    members: agents.map((item, index) => ({
      agentId: item.getId(),
      role: specs[index][1],
      status: "queued",
    })),
    agents,
  };
  state.activeModules.set(moduleId, module);
  for (const item of agents) join(item);
  state.log("module.spawn", "Sysadmin instantiated Communication Module", {
    moduleId,
    requestedBy: request.requestedBy || null,
    agentIds: agents.map((item) => item.getId()),
  });

  publish("communication.work", sysadmin, {
    moduleId,
    requestedBy: request.requestedBy || null,
    sourceLanguage: request.sourceLanguage || null,
    corporateLanguage: request.corporateLanguage || "English",
  });

  setTimeout(() => teardownModule(moduleId), 4200);
  return module;
}

export function teardownModule(moduleId) {
  const state = resolveRuntime().state;
  const module = state.activeModules.get(moduleId);
  if (!module) return false;
  for (const agent of module.agents) leave(agent);
  state.activeModules.delete(moduleId);
  state.log("module.release", "Communication Module released", {
    moduleId,
    agentIds: module.agents.map((item) => item.getId()),
  });
  return true;
}

export function triggerEmployeeAction(controller, employeeId) {
  const event = SemanticEvent.create("employee.action", controller.getId(), { employeeId });
  sendEvent(event, controller.getId());
}
