import { createAgent, SituationSpecification } from "@mozaik-ai/core";
import {
  CorporateNetworkState,
  initializeRuntime,
  join,
  leave,
  resolveRuntime,
  runLoop,
} from "./network-runtime.js";

const MODEL = "gpt-5.4-mini";

class ModelAnswerSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "model.answer";
  }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("\n🧪 Dynamic agent inference smoke test");
console.log("1. Starting runtime before creating the inference agent...");

initializeRuntime({ state: new CorporateNetworkState() });

let result = null;
let agent;

agent = createAgent({
  name: "Dynamic Inference Agent",
  capabilities: ["inference"],
  instruction: "You are a temporary employee-support agent created on demand. Follow the request exactly and answer concisely.",
  tools: [],
  handlers: [
    {
      specification: new ModelAnswerSpecification(),
      processor: {
        apply({ event }) {
          if (event.producerId !== agent.getId()) return;
          const text = answerText(event.payload?.answer).trim();
          result = {
            agentId: agent.getId(),
            text,
            receivedAt: Date.now(),
          };
          resolveRuntime().state.dynamicInferenceResult = result;
          console.log(`✅ model.answer received from dynamically created agent ${agent.getId()}`);
          console.log(`   Answer: ${text}`);
        },
      },
    },
  ],
});

console.log(`2. Agent created after runtime start: ${agent.getId()}`);
join(agent);
console.log("3. Agent joined. Starting a real inference...");

runLoop(
  agent.getId(),
  "Reply with exactly these three words: dynamic inference works",
  inferenceInput(agent),
);

const timeoutAt = Date.now() + 30000;
while (!result && Date.now() < timeoutAt) {
  await sleep(100);
}

console.log("\n--- RESULT ---");
if (!result) {
  console.error("❌ FAIL — no model.answer was received within 30 seconds.");
  process.exitCode = 1;
} else {
  console.log("Shared-state result:", resolveRuntime().state.dynamicInferenceResult);
  console.log("✅ PASS — an agent created after runtime start successfully ran real LLM inference.");

  const id = agent.getId();
  leave(agent);
  const stillPresent = resolveRuntime().state.getParticipants().some((participant) => participant.getId() === id);
  if (stillPresent) {
    console.error("❌ FAIL — inferred agent could not be removed after completion.");
    process.exitCode = 1;
  } else {
    console.log("✅ PASS — the inferred agent was removed from the runtime after completion.");
    console.log("✅ PASS — temporary real-LLM agents are viable for the on-demand Communication Module.");
  }
}
