import { createAgent, SemanticEvent, SituationSpecification } from "@mozaik-ai/core";
import { join, leave, resolveRuntime, runLoop, sendEvent } from "./network-runtime.js";

const MODEL = "gpt-5.4-mini";
const REAL_LLM_ENABLED = Boolean(process.env.OPENAI_API_KEY) && process.env.NETWORK_LLM !== "0";

class EmployeeActionSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "employee.action"; }
}

class ModuleRequestedSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "module.requested"; }
}

class CommunicationWorkSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "communication.work"; }
}

class ModelAnswerSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "model.answer"; }
}

function publish(type, producer, payload) {
  const event = SemanticEvent.create(type, producer.getId(), payload);
  sendEvent(event, producer.getId());
}

function answerText(answer) {
  if (typeof answer === "string") return answer;
  if (answer?.content?.text) return answer.content.text;
  if (Array.isArray(answer?.content)) {
    return answer.content.map((part) => part?.text ?? "").join("").trim();
  }
  return String(answer ?? "");
}

function inferenceInput(agent) {
  return {
    model: MODEL,
    context: agent.getMemory().getContext(),
    tools: agent.getTools(),
  };
}

function rolePrompt(role, work) {
  const sourceLanguage = work.sourceLanguage || "the employee's language";
  const corporateLanguage = work.corporateLanguage || "English";
  const sourceText = work.text || "Please confirm that the project update was received.";

  if (role === "Translator") {
    return `Translate this ${sourceLanguage} corporate message into ${corporateLanguage}. Preserve names, dates, numbers, requests, commitments and uncertainty exactly. Remove only obvious speech clutter. Do not invent facts. Return only the translated message.\n\n${sourceText}`;
  }

  if (role === "Editor" && work.phase === "final") {
    return `Produce the final edited ${corporateLanguage} message using the shared-state Translator draft and your own earlier editing analysis. The source message remains authoritative for facts. Preserve all names, dates, numbers, requests, commitments and uncertainty. Do not invent actors, deadlines, promises or responsibilities. Return only the final edited message.\n\nSource: ${sourceText}\n\nShared Translator draft: ${work.translatorDraft}\n\nYour earlier analysis: ${work.analysis}`;
  }

  if (role === "Editor") {
    return `Analyze this ${sourceLanguage} corporate message while the Translator works in parallel. Do not translate it yet. Return one concise editing brief describing the factual intent, tone, ambiguity and any speech clutter that may be removed. Never invent actors, deadlines, promises or responsibilities.\n\n${sourceText}`;
  }

  if (role === "Voice Writer" && work.phase === "final") {
    return `Create the final natural spoken ${corporateLanguage} version using the shared-state Translator draft and your own earlier voice-delivery plan. Keep every factual detail unchanged. Use short, easy-to-hear sentences. Do not add facts, requests, promises, actors, reasons or commitments. Return only the spoken script.\n\nSource: ${sourceText}\n\nShared Translator draft: ${work.translatorDraft}\n\nYour earlier voice plan: ${work.analysis}`;
  }

  return `Analyze this ${sourceLanguage} corporate message while the Translator works in parallel. Do not translate it yet. Return one concise voice-delivery plan for a later ${corporateLanguage} spoken version: rhythm, sentence length, and what filler may be removed. Preserve all facts and ambiguity exactly.\n\n${sourceText}`;
}

function fallbackResult(role, work) {
  const sourceText = work.text || "Corporate message received.";
  if (role === "Translator") return `[fallback translation] ${sourceText}`;
  if (role === "Editor") return `[fallback edited] ${sourceText}`;
  return `[fallback voice] ${sourceText}`;
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
            const text = event.payload?.text || profile.sampleText || "Please confirm that the project update was received.";
            state.log("employee.action", `${profile.name} requested multilingual communication`, {
              employeeId: profile.id,
              agentId: agent.getId(),
              office: profile.office,
              language: profile.language,
              text,
            });
            publish("module.requested", agent, {
              moduleType: "communication",
              requestedBy: profile.id,
              requestedByName: profile.name,
              sourceLanguage: profile.language,
              corporateLanguage: "English",
              text,
            });
          },
        },
      },
    ],
  });
  return agent;
}

function ensureRequestRecord(module, work) {
  let record = module.requests.find((item) => item.requestId === work.requestId);
  if (!record) {
    record = {
      requestId: work.requestId,
      requestedBy: work.requestedBy || null,
      requestedByName: work.requestedByName || work.requestedBy || "employee",
      sourceLanguage: work.sourceLanguage || null,
      corporateLanguage: work.corporateLanguage || "English",
      text: work.text || "",
      createdAt: Date.now(),
      analyses: {},
      results: {},
    };
    module.requests.push(record);
    if (module.requests.length > 8) module.requests.shift();
  }
  return record;
}

function scheduleTeardownWhenIdle(moduleId) {
  const state = resolveRuntime().state;
  const module = state.activeModules.get(moduleId);
  if (!module) return;
  const busy = module.members.some((member) => member.busy || member.queue.length);
  if (busy) return;
  if (module.teardownTimer) clearTimeout(module.teardownTimer);
  module.teardownTimer = setTimeout(() => teardownModule(moduleId), 3500);
}

function startCoordinatedFinal(module, member, request, baseWork) {
  if (!module || module.mode !== "real-llm" || member.role === "Translator") return false;
  const translator = request.results?.Translator?.text;
  const analysis = request.analyses?.[member.role]?.text;
  if (!translator || !analysis) return false;
  if (member.currentWork?.requestId !== request.requestId || member.status !== "waiting") return false;

  const work = {
    ...baseWork,
    phase: "final",
    translatorDraft: translator,
    analysis,
  };
  member.currentWork = work;
  member.status = "coordinating";
  member.startedAt = Date.now();

  const state = resolveRuntime().state;
  state.log("module.coordinate", `${member.role} consumed Translator output from shared state`, {
    moduleId: module.id,
    agentId: member.agentId,
    requestId: request.requestId,
  });

  try {
    runLoop(member.agentId, rolePrompt(member.role, work), inferenceInput(member.agent));
  } catch (error) {
    state.log("module.error", `${member.role} coordinated inference failed; fallback used`, {
      moduleId: module.id,
      agentId: member.agentId,
      requestId: request.requestId,
      error: error?.message || String(error),
    });
    completeMemberWork(module, member, work, fallbackResult(member.role, work), "fallback-after-error");
  }
  return true;
}

function completeMemberWork(module, member, work, text, mode) {
  const state = resolveRuntime().state;
  const request = ensureRequestRecord(module, work);

  if (module.mode === "real-llm" && member.role !== "Translator" && work.phase !== "final") {
    request.analyses[member.role] = {
      text,
      mode,
      completedAt: Date.now(),
      agentId: member.agentId,
    };
    member.status = "waiting";
    member.completedAt = Date.now();
    member.busy = true;
    member.currentWork = { ...work, phase: "waiting" };
    state.log("module.analysis", `${member.role} finished parallel analysis and is waiting for shared Translator output`, {
      moduleId: module.id,
      agentId: member.agentId,
      requestedBy: work.requestedBy || null,
      requestId: work.requestId,
      mode,
    });
    startCoordinatedFinal(module, member, request, work);
    return;
  }

  request.results[member.role] = {
    text,
    mode,
    completedAt: Date.now(),
    agentId: member.agentId,
  };
  member.status = "done";
  member.completedAt = Date.now();
  member.busy = false;
  member.currentWork = null;

  state.log("module.done", `${member.role} completed communication work`, {
    moduleId: module.id,
    agentId: member.agentId,
    requestedBy: work.requestedBy || null,
    requestId: work.requestId,
    mode,
  });

  if (member.role === "Translator" && module.mode === "real-llm") {
    for (const specialist of module.members) {
      if (specialist.role === "Translator") continue;
      if (specialist.currentWork?.requestId !== work.requestId || specialist.status !== "waiting") continue;
      startCoordinatedFinal(module, specialist, request, specialist.currentWork);
    }
  }

  startNextMemberWork(module, member);
  scheduleTeardownWhenIdle(module.id);
}

function startNextMemberWork(module, member) {
  if (!module || member.busy || member.queue.length === 0) return;
  const work = member.queue.shift();
  member.busy = true;
  member.status = "running";
  member.startedAt = Date.now();
  member.currentWork = work;

  const state = resolveRuntime().state;
  state.log("module.work", `${member.role} started for ${work.requestedByName || work.requestedBy || "employee"}`, {
    moduleId: module.id,
    agentId: member.agentId,
    requestedBy: work.requestedBy || null,
    requestId: work.requestId,
    phase: work.phase || null,
    mode: module.mode,
  });

  if (module.mode !== "real-llm") {
    const delay = member.role === "Translator" ? 900 : member.role === "Editor" ? 1250 : 1600;
    setTimeout(() => {
      const live = resolveRuntime().state.activeModules.get(module.id);
      if (!live) return;
      const current = live.members.find((item) => item.agentId === member.agentId);
      if (!current || current.currentWork?.requestId !== work.requestId) return;
      completeMemberWork(live, current, work, fallbackResult(current.role, work), "fallback");
    }, delay);
    return;
  }

  try {
    runLoop(member.agentId, rolePrompt(member.role, work), inferenceInput(member.agent));
  } catch (error) {
    state.log("module.error", `${member.role} inference failed; fallback used`, {
      moduleId: module.id,
      agentId: member.agentId,
      requestId: work.requestId,
      error: error?.message || String(error),
    });
    completeMemberWork(module, member, work, fallbackResult(member.role, work), "fallback-after-error");
  }
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
            const work = {
              requestId: event.payload?.requestId,
              requestedBy: event.payload?.requestedBy || null,
              requestedByName: event.payload?.requestedByName || null,
              sourceLanguage: event.payload?.sourceLanguage || null,
              corporateLanguage: event.payload?.corporateLanguage || "English",
              text: event.payload?.text || "",
              phase: role === "Translator" ? "translation" : "analysis",
            };
            member.queue.push(work);
            if (!member.busy) startNextMemberWork(module, member);
          },
        },
      },
      {
        specification: new ModelAnswerSpecification(),
        processor: {
          apply({ event }) {
            if (event.producerId !== agent.getId()) return;
            const state = resolveRuntime().state;
            const module = state.activeModules.get(moduleId);
            if (!module) return;
            const member = module.members.find((item) => item.agentId === agent.getId());
            if (!member?.busy || !member.currentWork) return;
            const text = answerText(event.payload?.answer).trim();
            completeMemberWork(module, member, member.currentWork, text || fallbackResult(role, member.currentWork), text ? "real-llm" : "fallback-empty-answer");
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
    instruction: "Monitor corporate agent capacity and instantiate or release temporary specialist modules when requested.",
    tools: [],
    handlers: [
      {
        specification: new ModuleRequestedSpecification(),
        processor: {
          apply({ event }) {
            if (event.payload?.moduleType !== "communication") return;
            const state = resolveRuntime().state;
            const existing = [...state.activeModules.values()].find((module) => module.type === "Communication Module");
            if (existing) {
              routeCommunicationWork(agent, existing, event.payload);
              return;
            }
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

function routeCommunicationWork(sysadmin, module, request = {}) {
  const state = resolveRuntime().state;
  module.requestedBy = request.requestedBy || null;
  module.requestCount = (module.requestCount || 0) + 1;
  module.lastRequestedAt = Date.now();
  module.status = "active";
  const requestId = `${module.id}-r${module.requestCount}`;

  if (module.teardownTimer) {
    clearTimeout(module.teardownTimer);
    module.teardownTimer = null;
  }

  if (module.requestCount > 1) {
    state.log("module.reuse", "Sysadmin routed a new request to the active Communication Module", {
      moduleId: module.id,
      requestedBy: request.requestedBy || null,
      requestCount: module.requestCount,
      mode: module.mode,
    });
  }

  ensureRequestRecord(module, { ...request, requestId });
  publish("communication.work", sysadmin, {
    moduleId: module.id,
    requestId,
    requestedBy: request.requestedBy || null,
    requestedByName: request.requestedByName || null,
    sourceLanguage: request.sourceLanguage || null,
    corporateLanguage: request.corporateLanguage || "English",
    text: request.text || "",
  });
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
    mode: REAL_LLM_ENABLED ? "real-llm" : "fallback",
    requestedBy: request.requestedBy || null,
    createdAt: Date.now(),
    lastRequestedAt: Date.now(),
    requestCount: 0,
    status: "active",
    requests: [],
    members: agents.map((item, index) => ({
      agentId: item.getId(),
      agent: item,
      role: specs[index][1],
      status: "queued",
      busy: false,
      queue: [],
      currentWork: null,
    })),
    agents,
    teardownTimer: null,
  };
  state.activeModules.set(moduleId, module);
  for (const item of agents) join(item);
  state.log("module.spawn", `Sysadmin instantiated Communication Module (${module.mode})`, {
    moduleId,
    requestedBy: request.requestedBy || null,
    agentIds: agents.map((item) => item.getId()),
    mode: module.mode,
  });

  routeCommunicationWork(sysadmin, module, request);
  return module;
}

export function teardownModule(moduleId) {
  const state = resolveRuntime().state;
  const module = state.activeModules.get(moduleId);
  if (!module) return false;
  if (module.teardownTimer) clearTimeout(module.teardownTimer);
  for (const agent of module.agents) leave(agent);
  state.activeModules.delete(moduleId);
  state.log("module.release", "Communication Module released after idle timeout", {
    moduleId,
    requestCount: module.requestCount || 0,
    agentIds: module.agents.map((item) => item.getId()),
    mode: module.mode,
  });
  return true;
}

export function triggerEmployeeAction(controller, employeeId, text = null) {
  const event = SemanticEvent.create("employee.action", controller.getId(), { employeeId, text });
  sendEvent(event, controller.getId());
}
