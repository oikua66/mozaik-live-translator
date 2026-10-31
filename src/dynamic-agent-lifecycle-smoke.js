import {
  createAgent,
  SemanticEvent,
  SituationSpecification,
} from "@mozaik-ai/core";
import {
  initializeRuntime,
  join,
  leave,
  resolveRuntime,
  sendEvent,
  TranslatorState,
} from "./runtime.js";

class EmployeeMessageSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "employee.message";
  }
}

function createEmployeeAgent(profile, receivedLog) {
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
            receivedLog.push({
              employeeId: profile.id,
              agentId: agent.getId(),
              sequence: event.payload.sequence,
              text: event.payload.text,
              receivedAt: Date.now(),
            });
          },
        },
      },
    ],
  });
  return agent;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendTargeted(controller, profile, sequence, text) {
  const event = SemanticEvent.create("employee.message", controller.getId(), {
    employeeId: profile.id,
    sequence,
    text,
  });
  sendEvent(event, controller.getId());
}

console.log("\n🧪 Dynamic agent lifecycle smoke test");
console.log("Goal: join → receive → leave → ignore → recreate → receive again\n");

initializeRuntime({
  state: new TranslatorState({ sourceLanguage: "en", targetLanguage: "en", outputStyle: "polite" }),
});

const controller = createAgent({
  name: "Lifecycle Test Controller",
  capabilities: ["inference"],
  instruction: "Lifecycle test controller only.",
  tools: [],
  handlers: [],
});
join(controller);

const profile = {
  id: "kyiv-olena",
  name: "Olena",
  office: "Kyiv",
  language: "ukrainian",
  role: "Project Manager",
};

const receivedLog = [];

console.log("1. Creating first personal agent after runtime start...");
const firstAgent = createEmployeeAgent(profile, receivedLog);
join(firstAgent);
console.log(`   JOINED ${firstAgent.getId()}`);

sendTargeted(controller, profile, 1, "First message while first agent is active.");
await sleep(250);

console.log("2. Removing the first agent from runtime...");
leave(firstAgent);
console.log(`   LEFT ${firstAgent.getId()}`);

sendTargeted(controller, profile, 2, "This message must NOT be received after leave().");
await sleep(250);

console.log("3. Recreating a fresh personal agent for the same employee...");
const secondAgent = createEmployeeAgent(profile, receivedLog);
join(secondAgent);
console.log(`   REJOINED as new agent ${secondAgent.getId()}`);

sendTargeted(controller, profile, 3, "Third message after fresh agent creation.");
await sleep(250);

const sequences = receivedLog.map((item) => item.sequence);
const firstReceived = sequences.includes(1);
const ignoredAfterLeave = !sequences.includes(2);
const thirdReceived = sequences.includes(3);
const newIdentity = firstAgent.getId() !== secondAgent.getId();
const participants = resolveRuntime().state.getParticipants?.() || [];
const participantIds = participants.map((participant) => participant.getId?.()).filter(Boolean);
const oldStillPresent = participantIds.includes(firstAgent.getId());
const newPresent = participantIds.includes(secondAgent.getId());

console.log("\n--- RESULT ---");
console.log("First agent ID:", firstAgent.getId());
console.log("Second agent ID:", secondAgent.getId());
console.log("Received log:", receivedLog);
console.log("Current participant IDs:", participantIds);

const failures = [];
if (!firstReceived) failures.push("first agent did not receive the pre-leave event");
if (!ignoredAfterLeave) failures.push("left agent still received an event after leave()");
if (!thirdReceived) failures.push("fresh agent did not receive the post-rejoin event");
if (!newIdentity) failures.push("recreated agent did not get a new identity");
if (oldStillPresent) failures.push("old agent remains in runtime participant registry after leave()");
if (!newPresent) failures.push("new agent is missing from runtime participant registry");

if (failures.length) {
  console.error("❌ FAIL — lifecycle assumptions were not fully satisfied:");
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("✅ PASS — joined agent received events while active.");
  console.log("✅ PASS — leave() removed the agent from event handling and participant registry.");
  console.log("✅ PASS — the same employee can receive a freshly created agent with a new ID and resume immediately.");
  console.log("✅ PASS — elastic personal-agent lifecycle is technically viable for the demo architecture.");
}
