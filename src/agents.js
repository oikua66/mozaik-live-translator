import {
  createAgent,
  SemanticEvent,
  SituationSpecification,
} from "@mozaik-ai/core";
import { resolveRuntime, runLoop, sendEvent } from "./runtime.js";

const MODEL = "gpt-5.4-mini";

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

function publishCustomEvent(type, producer, payload) {
  const event = SemanticEvent.create(type, producer.getId(), payload);
  sendEvent(event, producer.getId());
}

function delta(fragment) {
  return Date.now() - (fragment.clientFinalAt || fragment.serverReceivedAt || fragment.createdAt);
}

function startNextSource(agent) {
  const state = resolveRuntime().state;
  if (state.sourceBusy || state.sourceQueue.length === 0) return;

  const fragmentId = state.sourceQueue.shift();
  const fragment = state.fragments.get(fragmentId);
  if (!fragment) return;

  state.sourceBusy = true;
  state.activeSourceFragmentId = fragmentId;

  console.log(`⏱ #${fragmentId} Source START +${delta(fragment)} ms`);
  console.log(`🔵 Source Agent START #${fragmentId}: ${fragment.rawSourceText}`);

  runLoop(
    agent.getId(),
    `Restore punctuation and normal capitalization in this ${state.sourceLanguage} speech transcript. Do not translate, paraphrase, add, remove, or explain anything. Return only the corrected transcript:\n\n${fragment.rawSourceText}`,
    inferenceInput(agent),
  );
}

function startNextTranslation(agent) {
  const state = resolveRuntime().state;
  if (state.translationBusy || state.translationQueue.length === 0) return;

  const fragmentId = state.translationQueue.shift();
  const fragment = state.fragments.get(fragmentId);
  if (!fragment) return;

  state.translationBusy = true;
  state.activeTranslationFragmentId = fragmentId;
  fragment.translationStatus = "running";

  console.log(`⏱ #${fragmentId} Translator START +${delta(fragment)} ms`);
  console.log(`🟠 Translator START #${fragmentId}: ${fragment.rawSourceText}`);

  runLoop(
    agent.getId(),
    `Translate this ${state.sourceLanguage} speech transcript into ${state.targetLanguage}. Correct obvious missing punctuation implicitly, preserve meaning and tone, and return only the translation with no commentary:\n\n${fragment.rawSourceText}`,
    inferenceInput(agent),
  );
}

function queuePolish(fragmentId) {
  const state = resolveRuntime().state;
  const fragment = state.fragments.get(fragmentId);
  if (!fragment || fragment.polishQueued || fragment.editingStatus === "done") return;
  if (!fragment.rawTranslation || fragment.briefStatus !== "done") return;

  fragment.polishQueued = true;
  fragment.editingStatus = "queued";
  state.editQueue.push({ fragmentId, phase: "polish" });
  startNextEdit(editorAgent);
}

function startNextEdit(agent) {
  const state = resolveRuntime().state;
  if (state.editBusy || state.editQueue.length === 0) return;

  const task = state.editQueue.shift();
  const { fragmentId, phase } = task;
  const fragment = state.fragments.get(fragmentId);
  if (!fragment) return;

  state.editBusy = true;
  state.activeEditTask = task;

  if (phase === "brief") {
    fragment.briefStatus = "running";
    console.log(`⏱ #${fragmentId} Editor BRIEF START +${delta(fragment)} ms`);
    console.log(`🟣 Editor Agent BRIEF START #${fragmentId}`);

    runLoop(
      agent.getId(),
      `Read this ${state.sourceLanguage} speech fragment and prepare a very short editing brief for a later translator output. Identify tone/register and any wording that must be preserved. Do not translate the sentence. Return one concise line only:\n\n${fragment.rawSourceText}`,
      inferenceInput(agent),
    );
    return;
  }

  fragment.editingStatus = "running";
  const previous = [...state.fragments.values()]
    .filter((item) => item.id < fragmentId && item.finalText)
    .map((item) => item.finalText)
    .slice(-2)
    .join(" ");

  console.log(`⏱ #${fragmentId} Editor POLISH START +${delta(fragment)} ms`);
  console.log(`🟣 Editor Agent POLISH START #${fragmentId}`);

  runLoop(
    agent.getId(),
    `Review the translation conservatively. If it is already natural, accurate, and appropriate for the intended register, return it unchanged. Only edit when there is a real problem: mistranslation, awkward phrasing, wrong register, grammar, punctuation, or lost meaning. Do not replace natural wording merely with stylistic alternatives. Preserve greetings, level of formality, and the speaker's intent. Return only the final translation, with no commentary.\n\nEditing brief: ${fragment.styleBrief || "Preserve tone and meaning."}\n\nPrevious context: ${previous || "(none)"}\n\nSource transcript: ${fragment.sourceText || fragment.rawSourceText}\n\nTranslation: ${fragment.rawTranslation}`,
    inferenceInput(agent),
  );
}

class SourceFragmentSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "source.fragment";
  }
}

class FragmentCreatedSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "fragment.created";
  }
}

class TranslationReadySpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "translation.ready";
  }
}

class ModelAnswerSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "model.answer";
  }
}

export const inputAgent = createAgent({
  name: "Source Agent",
  capabilities: ["inference"],
  instruction: "You clean speech transcripts by restoring punctuation and capitalization without changing the speaker's wording or meaning.",
  tools: [],
  handlers: [
    {
      specification: new SourceFragmentSpecification(),
      processor: {
        apply({ event }) {
          const state = resolveRuntime().state;
          const { id, text, clientFinalAt, serverReceivedAt } = event.payload;
          const fragment = state.createFragment(id, text, { clientFinalAt, serverReceivedAt });
          state.sourceQueue.push(id);
          console.log(`⏱ #${id} Fragment CREATED +${delta(fragment)} ms`);
          console.log(`🔵 Source QUEUED #${id}: ${fragment.rawSourceText}`);

          publishCustomEvent("fragment.created", inputAgent, { fragmentId: id });
          startNextSource(inputAgent);
        },
      },
    },
    {
      specification: new ModelAnswerSpecification(),
      processor: {
        apply({ event }) {
          if (event.producerId !== inputAgent.getId()) return;

          const state = resolveRuntime().state;
          const fragmentId = state.activeSourceFragmentId;
          const fragment = state.fragments.get(fragmentId);
          if (!fragment) return;

          fragment.sourceText = answerText(event.payload.answer).trim() || fragment.rawSourceText;
          fragment.sttStatus = "done";
          fragment.normalizedAt = Date.now();

          console.log(`⏱ #${fragmentId} Source DONE +${delta(fragment)} ms`);
          console.log(`✅ Source Agent DONE #${fragmentId}: ${fragment.sourceText}`);

          state.sourceBusy = false;
          state.activeSourceFragmentId = null;
          publishCustomEvent("source.normalized", inputAgent, { fragmentId });
          startNextSource(inputAgent);
        },
      },
    },
  ],
});

export const translatorAgent = createAgent({
  name: "Translator Agent",
  capabilities: ["inference"],
  instruction: "You are a fast professional translator. Preserve meaning and tone. Output only the translation.",
  tools: [],
  handlers: [
    {
      specification: new FragmentCreatedSpecification(),
      processor: {
        apply({ event }) {
          const state = resolveRuntime().state;
          state.translationQueue.push(event.payload.fragmentId);
          startNextTranslation(translatorAgent);
        },
      },
    },
    {
      specification: new ModelAnswerSpecification(),
      processor: {
        apply({ event }) {
          if (event.producerId !== translatorAgent.getId()) return;

          const state = resolveRuntime().state;
          const fragmentId = state.activeTranslationFragmentId;
          const fragment = state.fragments.get(fragmentId);
          if (!fragment) return;

          fragment.rawTranslation = answerText(event.payload.answer);
          fragment.translationStatus = "done";
          fragment.translatedAt = Date.now();

          console.log(`⏱ #${fragmentId} Translator DONE +${delta(fragment)} ms`);
          console.log(`✅ Translator DONE #${fragmentId}: ${fragment.rawTranslation}`);

          state.translationBusy = false;
          state.activeTranslationFragmentId = null;
          publishCustomEvent("translation.ready", translatorAgent, { fragmentId });
          startNextTranslation(translatorAgent);
        },
      },
    },
  ],
});

export const editorAgent = createAgent({
  name: "Editor Agent",
  capabilities: ["inference"],
  instruction: "You coordinate style analysis and conservative final polishing. Preserve good translations unchanged and only correct real problems.",
  tools: [],
  handlers: [
    {
      specification: new FragmentCreatedSpecification(),
      processor: {
        apply({ event }) {
          const state = resolveRuntime().state;
          const fragment = state.fragments.get(event.payload.fragmentId);
          if (!fragment) return;
          fragment.briefStatus = "queued";
          state.editQueue.push({ fragmentId: fragment.id, phase: "brief" });
          startNextEdit(editorAgent);
        },
      },
    },
    {
      specification: new TranslationReadySpecification(),
      processor: {
        apply({ event }) {
          queuePolish(event.payload.fragmentId);
        },
      },
    },
    {
      specification: new ModelAnswerSpecification(),
      processor: {
        apply({ event }) {
          if (event.producerId !== editorAgent.getId()) return;

          const state = resolveRuntime().state;
          const task = state.activeEditTask;
          if (!task) return;
          const fragment = state.fragments.get(task.fragmentId);
          if (!fragment) return;

          if (task.phase === "brief") {
            fragment.styleBrief = answerText(event.payload.answer).trim();
            fragment.briefStatus = "done";
            fragment.briefedAt = Date.now();
            console.log(`⏱ #${fragment.id} Editor BRIEF DONE +${delta(fragment)} ms`);
            console.log(`✅ Editor Agent BRIEF DONE #${fragment.id}: ${fragment.styleBrief}`);

            state.editBusy = false;
            state.activeEditTask = null;
            queuePolish(fragment.id);
            startNextEdit(editorAgent);
            return;
          }

          fragment.finalText = answerText(event.payload.answer);
          fragment.editingStatus = "done";
          fragment.completedAt = Date.now();

          console.log(`⏱ #${fragment.id} Editor POLISH DONE +${delta(fragment)} ms`);
          console.log(`✅ Editor Agent POLISH DONE #${fragment.id}: ${fragment.finalText}`);

          state.editBusy = false;
          state.activeEditTask = null;
          publishCustomEvent("output.ready", editorAgent, { fragmentId: fragment.id });
          startNextEdit(editorAgent);
        },
      },
    },
  ],
});
