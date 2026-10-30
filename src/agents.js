import {
  createAgent,
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

function startNextTranslation(agent) {
  const state = resolveRuntime().state;
  if (state.translationBusy || state.translationQueue.length === 0) return;

  const fragmentId = state.translationQueue.shift();
  const fragment = state.fragments.get(fragmentId);
  if (!fragment) return;

  state.translationBusy = true;
  state.activeTranslationFragmentId = fragmentId;
  fragment.translationStatus = "running";

  console.log(`🟠 Translator START #${fragmentId}: ${fragment.sourceText}`);

  runLoop(
    agent.getId(),
    `Translate this ${state.sourceLanguage} text into ${state.targetLanguage}. Return only the translation, no commentary:\n\n${fragment.sourceText}`,
    inferenceInput(agent),
  );
}

function startNextEdit(agent) {
  const state = resolveRuntime().state;
  if (state.editBusy || state.editQueue.length === 0) return;

  const fragmentId = state.editQueue.shift();
  const fragment = state.fragments.get(fragmentId);
  if (!fragment) return;

  state.editBusy = true;
  state.activeEditFragmentId = fragmentId;
  fragment.editingStatus = "running";

  const previous = [...state.fragments.values()]
    .filter((item) => item.id < fragmentId && item.finalText)
    .map((item) => item.finalText)
    .slice(-2)
    .join(" ");

  console.log(`🟣 Editor START #${fragmentId}`);

  runLoop(
    agent.getId(),
    `Polish this translated fragment so it sounds natural in ${state.targetLanguage}. Preserve meaning. Return only the polished fragment.\n\nPrevious context: ${previous || "(none)"}\n\nFragment: ${fragment.rawTranslation}`,
    inferenceInput(agent),
  );
}

class SourceFragmentSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "source.fragment";
  }
}

class FragmentReadySpecification extends SituationSpecification {
  isSatisfiedBy({ event }) {
    return event.type === "fragment.ready";
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
  name: "Input Agent",
  capabilities: [],
  instruction: "Receive source fragments and publish them into shared runtime state.",
  tools: [],
  handlers: [
    {
      specification: new SourceFragmentSpecification(),
      processor: {
        apply({ event }) {
          const state = resolveRuntime().state;
          const { id, text } = event.payload;
          const fragment = state.createFragment(id, text);
          console.log(`🔵 Input READY #${id}: ${fragment.sourceText}`);
          sendEvent("fragment.ready", { fragmentId: id }, inputAgent.getId());
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
      specification: new FragmentReadySpecification(),
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

          console.log(`✅ Translator DONE #${fragmentId}: ${fragment.rawTranslation}`);

          state.translationBusy = false;
          state.activeTranslationFragmentId = null;
          sendEvent("translation.ready", { fragmentId }, translatorAgent.getId());
          startNextTranslation(translatorAgent);
        },
      },
    },
  ],
});

export const editorAgent = createAgent({
  name: "Editor Agent",
  capabilities: ["inference"],
  instruction: "You are a concise language editor. Make translated fragments natural and coherent without changing meaning.",
  tools: [],
  handlers: [
    {
      specification: new TranslationReadySpecification(),
      processor: {
        apply({ event }) {
          const state = resolveRuntime().state;
          state.editQueue.push(event.payload.fragmentId);
          startNextEdit(editorAgent);
        },
      },
    },
    {
      specification: new ModelAnswerSpecification(),
      processor: {
        apply({ event }) {
          if (event.producerId !== editorAgent.getId()) return;

          const state = resolveRuntime().state;
          const fragmentId = state.activeEditFragmentId;
          const fragment = state.fragments.get(fragmentId);
          if (!fragment) return;

          fragment.finalText = answerText(event.payload.answer);
          fragment.editingStatus = "done";
          fragment.completedAt = Date.now();

          console.log(`✅ Editor DONE #${fragmentId}: ${fragment.finalText}`);

          state.editBusy = false;
          state.activeEditFragmentId = null;
          sendEvent("output.ready", { fragmentId }, editorAgent.getId());
          startNextEdit(editorAgent);
        },
      },
    },
  ],
});
