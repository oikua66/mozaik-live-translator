import {
  createAgent,
  SemanticEvent,
  SituationSpecification,
} from "@mozaik-ai/core";
import {
  initializeRuntime,
  join,
  resolveRuntime,
  sendEvent,
  TranslatorState,
} from "./runtime.js";

class EmployeeMessageSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "employee.message";
  }
}

function createEmployeeAgent(profile, received) {
  let agent;

  agent = createAgent({
    name: `${profile.name} Agent`,
    capabilities: ["inference"],
    instruction: `You represent ${profile.name}, ${profile.role} in ${profile.office}. Preferred language: ${profile.language}.`,
    tools: [],
    handlers: [
      {
        specification: new EmployeeMessageSpecification(),
        processor: {
          apply({ event }) {
            if (event.payload?.employeeId !== profile.id) return;

            const state = resolveRuntime().state;
            const record = {
              employeeId: profile.id,
              employeeName: profile.name,
              agentId: agent.getId(),
              text: event.payload.text,
              receivedAt: Date.now(),
            };

            if (!state.dynamicAgentMessages) state.dynamicAgentMessages = [];
            state.dynamicAgentMessages.push(record);
            received.add(profile.id);

            console.log(`✅ ${profile.name} Agent (${agent.getId()}) received its event: ${event.payload.text}`);
          },
        },
      },
    ],
  });

  return agent;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("\n🧪 Dynamic agent smoke test");
console.log("1. Starting Mozaik runtime with no employee agents...");

initializeRuntime({
  state: new TranslatorState({
    sourceLanguage: "en",
    targetLanguage: "en",
    outputStyle: "polite",
  }),
});

const controller = createAgent({
  name: "Dynamic Agent Test Controller",
  capabilities: ["inference"],
  instruction: "Test controller only.",
  tools: [],
  handlers: [],
});
join(controller);

console.log("2. Runtime is already live. Creating employees dynamically...");

const received = new Set();
const employees = [
  {
    id: "kyiv-olena",
    name: "Olena",
    office: "Kyiv",
    language: "ukrainian",
    role: "Project Manager",
  },
  {
    id: "novi-sad-marko",
    name: "Marko",
    office: "Novi Sad",
    language: "serbian",
    role: "Engineer",
  },
];

const employeeAgents = employees.map((profile) => {
  const agent = createEmployeeAgent(profile, received);
  join(agent);
  console.log(`➕ JOINED dynamically: ${profile.name} (${profile.office}) — ${agent.getId()}`);
  return { profile, agent };
});

console.log("3. Sending targeted semantic events after dynamic join...");

for (const { profile } of employeeAgents) {
  const event = SemanticEvent.create("employee.message", controller.getId(), {
    employeeId: profile.id,
    text: `Hello ${profile.name}. This event was sent after your agent was created.`,
  });
  sendEvent(event, controller.getId());
}

await sleep(500);

const state = resolveRuntime().state;
const expected = new Set(employees.map((employee) => employee.id));
const missing = [...expected].filter((id) => !received.has(id));
const invalidAgentIds = (state.dynamicAgentMessages || []).filter((record) => !record.agentId);

console.log("\n--- RESULT ---");
console.log(`Dynamic employee agents created: ${employeeAgents.length}`);
console.log(`Targeted events received: ${received.size}`);
console.log("Shared-state records:", state.dynamicAgentMessages || []);

if (missing.length) {
  console.error(`❌ FAIL — agents did not receive events: ${missing.join(", ")}`);
  process.exitCode = 1;
} else if (invalidAgentIds.length) {
  console.error("❌ FAIL — one or more shared-state records are missing agentId.");
  process.exitCode = 1;
} else {
  console.log("✅ PASS — agents created after runtime start joined successfully and immediately handled semantic events.");
  console.log("✅ PASS — dynamic agents wrote valid agent IDs into shared RuntimeState.");
}
