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

function styleInstruction(style) {
  if (style === "polite") {
    return "Render the speaker's intended message in a polite, clean, natural form. The speaker may talk casually, abruptly, use fillers, profanity, rough wording, fragments, or self-corrections; preserve the factual intent but remove unnecessary roughness, profanity, filler, and speech clutter. Do not make the message excessively formal. Never invent a subject, object, request, apology, promise, reason, deadline, responsibility, or other fact that the speaker did not clearly state. If part of the source is ambiguous, use a conservative neutral formulation rather than guessing.";
  }
  if (style === "business") {
    return "Rewrite the speaker's intended message as concise, professional business communication rather than mirroring casual speech. Preserve every clearly stated factual point: names, dates, times, numbers, requests, commitments, constraints, and decisions. Remove profanity, filler, slang, repetition, rough phrasing, and conversational clutter. Never invent who must do something, what must be done, ownership, responsibility, promises, reasons, deadlines, or any other fact not clearly present in the source. If a clause is ambiguous after speech cleanup, omit the uncertain detail or express only the unambiguous intent; never guess. Keep the result compact, natural, and professional, not bureaucratic.";
  }
  return "Translate faithfully and naturally. Preserve the speaker's intended tone and level of formality while removing only obvious accidental speech noise and self-corrections when the intended wording is clear. Never invent facts to resolve ambiguity.";
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
    `Clean this ${state.sourceLanguage} speech transcript for meaning-preserving downstream translation. Restore punctuation and normal capitalization. Remove only obvious speech noise such as accidental repetitions, false starts, duplicated words, and immediate self-corrections when the intended wording is clear from context. If a phrase remains genuinely ambiguous, preserve that ambiguity instead of inventing a subject, object, action, or responsibility. Do not translate, embellish, summarize, or change the intended meaning. Return only the cleaned transcript:\n\n${fragment.rawSourceText}`,
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
    `Translate this ${state.sourceLanguage} speech transcript into ${state.targetLanguage}. ${styleInstruction(state.outputStyle)} Silently resolve obvious accidental repetitions, false starts, duplicated words, and immediate self-corrections only when intent is clear. Do not infer a new actor, object, task, responsibility, or commitment from broken speech. Return only the target-language message with no commentary:\n\n${fragment.rawSourceText}`,
    inferenceInput(agent),
  );
}

function queuePolish(fragmentId) {
  const state = resolveRuntime().state;
  const fragment = state.fragments.get(fragmentId);
  if (!fragment || fragment.polishQueued || fragment.editingStatus === "done") return;
  if (!fragment.rawTranslation || fragment.briefStatus !== "done") return;
  // Smart styles trade a little latency for reliability: reconcile against the cleaned source first.
  if (state.outputStyle !== "faithful" && fragment.sttStatus !== "done") return;

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
      `Read this ${state.sourceLanguage} speech fragment and prepare one very short editing brief for a later translator output. Desired output style: ${state.outputStyle}. Identify only the clearly supported intended meaning and facts that must be preserved. Flag ambiguity explicitly. Never infer an unstated actor, object, task, responsibility, promise, reason, or deadline. For smart styles, note profanity, filler, roughness, repetition, false starts, or self-corrections that can be cleaned. Do not translate the sentence. Return one concise line only:\n\n${fragment.rawSourceText}`,
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
    `Produce the final translation by reconciling the translator draft with the cleaned source transcript and the editing brief. ${styleInstruction(state.outputStyle)} The cleaned source is the authority for factual content. Delete any detail in the draft that is not clearly supported by the cleaned source, especially invented actors, objects, requests, responsibilities, reasons, promises, or commitments. If a source clause remains ambiguous, prefer a shorter neutral formulation or omit only that uncertain detail rather than guessing. Correct mistranslation, awkward phrasing, register, grammar, punctuation, and surviving speech noise. Return only the final target-language message, with no commentary.\n\nEditing brief: ${fragment.styleBrief || "Preserve only clearly supported intent."}\n\nPrevious context: ${previous || "(none)"}\n\nCleaned source transcript: ${fragment.sourceText || fragment.rawSourceText}\n\nTranslator draft: ${fragment.rawTranslation}`,
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
  instruction: "You clean speech transcripts for downstream translation: restore punctuation, remove obvious speech slips, and never invent meaning to resolve ambiguity.",
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
          queuePolish(fragmentId);
          startNextSource(inputAgent);
        },
      },
    },
  ],
});

export const translatorAgent = createAgent({
  name: "Translator Agent",
  capabilities: ["inference"],
  instruction: "You are a fast professional translator. Preserve factual intent and apply the selected output style without inventing content.",
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
  instruction: "You coordinate intent/style analysis and final factual reconciliation. Never invent facts to resolve broken speech.",
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

          fragment.finalText = answerText(event.payload.answer).trim() || fragment.rawTranslation;
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
