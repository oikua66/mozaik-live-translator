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
    return "Render the intended message in polite, clean, everyday spoken language. It should sound like a real person speaking naturally, not like a formal letter or bureaucratic translation. Prefer common conversational wording and contractions where natural. Avoid stiff phrases such as 'let us', 'carry out', 'therefore', or overly literary wording unless the source genuinely requires them. Remove profanity, filler, roughness, repetition, and speech clutter, but never invent facts, actors, requests, apologies, promises, reasons, deadlines, responsibilities, or commitments. If something is ambiguous, use a neutral formulation rather than guessing.";
  }
  if (style === "business") {
    return "Rewrite the intended message as concise, natural professional business communication. Preserve clearly stated names, dates, times, numbers, requests, commitments, constraints, and decisions. Remove profanity, filler, slang, repetition, rough phrasing, and conversational clutter. Keep it human and direct rather than bureaucratic. Never invent who must do something, what must be done, ownership, responsibility, promises, reasons, deadlines, or other facts. If a clause remains ambiguous, omit the uncertain detail or express only the unambiguous intent.";
  }
  return "Translate faithfully and naturally. Preserve the speaker's intended tone and formality while removing only obvious accidental speech noise and self-corrections when intent is clear. Never invent facts to resolve ambiguity.";
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
    `Clean this ${state.sourceLanguage} speech transcript for meaning-preserving downstream translation. Restore punctuation and capitalization. Remove obvious repetitions, false starts, duplicated words, and immediate self-corrections only when the intended wording is clear. Preserve genuine ambiguity rather than inventing meaning. Do not translate or embellish. Return only the cleaned transcript:\n\n${fragment.rawSourceText}`,
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
    `Translate this ${state.sourceLanguage} speech transcript into ${state.targetLanguage}. ${styleInstruction(state.outputStyle)} Resolve obvious accidental repetitions and self-corrections only when intent is clear. Do not infer a new actor, object, task, responsibility, or commitment from broken speech. Return only the target-language message:\n\n${fragment.rawSourceText}`,
    inferenceInput(agent),
  );
}

function queuePolish(fragmentId) {
  const state = resolveRuntime().state;
  const fragment = state.fragments.get(fragmentId);
  if (!fragment || fragment.polishQueued || fragment.editingStatus === "done") return;
  if (!fragment.rawTranslation || fragment.briefStatus !== "done") return;
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
      `Read this ${state.sourceLanguage} speech fragment and prepare one short editing brief. Desired output style: ${state.outputStyle}. Identify only clearly supported intent and facts, flag ambiguity, and note speech clutter that may be removed. Never infer unstated actors, tasks, responsibilities, promises, reasons, or deadlines. Do not translate. Return one concise line:\n\n${fragment.rawSourceText}`,
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
    `Produce the final translation by reconciling the translator draft with the cleaned source and editing brief. ${styleInstruction(state.outputStyle)} The cleaned source is authoritative for facts. Delete unsupported details instead of guessing. Correct mistranslation, awkward phrasing, register, grammar, punctuation, and surviving speech noise. Return only the final target-language message.\n\nEditing brief: ${fragment.styleBrief || "Preserve only clearly supported intent."}\n\nPrevious context: ${previous || "(none)"}\n\nCleaned source: ${fragment.sourceText || fragment.rawSourceText}\n\nTranslator draft: ${fragment.rawTranslation}`,
    inferenceInput(agent),
  );
}

function queueVoiceDraft(fragmentId) {
  const state = resolveRuntime().state;
  const fragment = state.fragments.get(fragmentId);
  if (!fragment || fragment.voiceDraftQueued || fragment.voiceDraftStatus === "done") return;
  if (!fragment.rawTranslation || fragment.voicePlanStatus !== "done") return;
  fragment.voiceDraftQueued = true;
  fragment.voiceDraftStatus = "queued";
  state.voiceQueue.push({ fragmentId, phase: "draft" });
  startNextVoice(voiceWriterAgent);
}

function queueVoiceFinal(fragmentId) {
  const state = resolveRuntime().state;
  const fragment = state.fragments.get(fragmentId);
  if (!fragment || fragment.voiceFinalQueued || fragment.voiceStatus === "done") return;
  if (!fragment.finalText || fragment.voiceDraftStatus !== "done") return;

  // Fast path: if Editor did not change the translator text, the parallel voice draft is already valid.
  if (fragment.finalText.trim() === fragment.rawTranslation.trim()) {
    fragment.spokenText = fragment.voiceDraft || fragment.finalText;
    fragment.voiceStatus = "done";
    fragment.voiceCompletedAt = Date.now();
    console.log(`⏱ #${fragment.id} Voice VERIFIED +${delta(fragment)} ms`);
    console.log(`✅ Voice Writer VERIFIED #${fragment.id}: ${fragment.spokenText}`);
    publishCustomEvent("voice.ready", voiceWriterAgent, { fragmentId: fragment.id });
    return;
  }

  fragment.voiceFinalQueued = true;
  fragment.voiceStatus = "queued";
  state.voiceQueue.push({ fragmentId, phase: "verify" });
  startNextVoice(voiceWriterAgent);
}

function startNextVoice(agent) {
  const state = resolveRuntime().state;
  if (state.voiceBusy || state.voiceQueue.length === 0) return;
  const task = state.voiceQueue.shift();
  const { fragmentId, phase } = task;
  const fragment = state.fragments.get(fragmentId);
  if (!fragment) return;

  state.voiceBusy = true;
  state.activeVoiceTask = task;

  if (phase === "plan") {
    fragment.voicePlanStatus = "running";
    console.log(`⏱ #${fragmentId} Voice PLAN START +${delta(fragment)} ms`);
    console.log(`🟢 Voice Writer PLAN START #${fragmentId}`);
    runLoop(
      agent.getId(),
      `Prepare one very short spoken-delivery plan for this ${state.sourceLanguage} utterance that will later be translated into ${state.targetLanguage}. Desired output style: ${state.outputStyle}. Focus on natural speech rhythm and what filler or roughness can be removed. Preserve facts and ambiguity exactly. Do not translate yet. Return one concise line:\n\n${fragment.rawSourceText}`,
      inferenceInput(agent),
    );
    return;
  }

  if (phase === "draft") {
    fragment.voiceDraftStatus = "running";
    console.log(`⏱ #${fragmentId} Voice DRAFT START +${delta(fragment)} ms`);
    console.log(`🟢 Voice Writer DRAFT START #${fragmentId}`);
    runLoop(
      agent.getId(),
      `Turn this ${state.targetLanguage} translator draft into a natural spoken version for text-to-speech while Editor works in parallel. Keep all factual content unchanged. Use short, easy-to-hear sentences and ordinary spoken wording. ${state.outputStyle === "polite" ? "For Polite & clean, sound warm and conversational, never stiff, literary, or bureaucratic." : "Keep the selected register natural when spoken aloud."} Do not add facts, requests, promises, actors, reasons, or commitments. Return only the spoken draft.\n\nVoice plan: ${fragment.voicePlan || "Natural spoken delivery."}\n\nTranslator draft: ${fragment.rawTranslation}`,
      inferenceInput(agent),
    );
    return;
  }

  fragment.voiceStatus = "running";
  console.log(`⏱ #${fragmentId} Voice VERIFY START +${delta(fragment)} ms`);
  console.log(`🟢 Voice Writer VERIFY START #${fragmentId}`);
  runLoop(
    agent.getId(),
    `Quickly reconcile the existing spoken draft with the Editor-verified text. Change only what is necessary to match the verified facts and meaning. Keep the spoken version natural, concise, conversational, and easy to hear. Do not perform a fresh rewrite if the draft is already correct. Do not add or remove substantive information. Return only the corrected spoken script.\n\nSpoken draft: ${fragment.voiceDraft}\n\nVerified text: ${fragment.finalText}`,
    inferenceInput(agent),
  );
}

class SourceFragmentSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "source.fragment"; }
}
class FragmentCreatedSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "fragment.created"; }
}
class TranslationReadySpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "translation.ready"; }
}
class OutputReadySpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "output.ready"; }
}
class ModelAnswerSpecification extends SituationSpecification {
  isSatisfiedBy({ event }) { return event.type === "model.answer"; }
}

export const inputAgent = createAgent({
  name: "Source Agent",
  capabilities: ["inference"],
  instruction: "Clean speech transcripts while preserving intended meaning and genuine ambiguity.",
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
  instruction: "Translate quickly while preserving factual intent and selected output style.",
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
          fragment.rawTranslation = answerText(event.payload.answer).trim();
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
  instruction: "Analyze intent and reconcile the final translation against the cleaned source without inventing facts.",
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
      processor: { apply({ event }) { queuePolish(event.payload.fragmentId); } },
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
          queueVoiceFinal(fragment.id);
          startNextEdit(editorAgent);
        },
      },
    },
  ],
});

export const voiceWriterAgent = createAgent({
  name: "Voice Writer Agent",
  capabilities: ["inference"],
  instruction: "Prepare natural spoken scripts for TTS in parallel with factual editing, then reconcile only when necessary.",
  tools: [],
  handlers: [
    {
      specification: new FragmentCreatedSpecification(),
      processor: {
        apply({ event }) {
          const state = resolveRuntime().state;
          const fragment = state.fragments.get(event.payload.fragmentId);
          if (!fragment) return;
          fragment.voicePlanStatus = "queued";
          state.voiceQueue.push({ fragmentId: fragment.id, phase: "plan" });
          startNextVoice(voiceWriterAgent);
        },
      },
    },
    {
      specification: new TranslationReadySpecification(),
      processor: { apply({ event }) { queueVoiceDraft(event.payload.fragmentId); } },
    },
    {
      specification: new OutputReadySpecification(),
      processor: { apply({ event }) { queueVoiceFinal(event.payload.fragmentId); } },
    },
    {
      specification: new ModelAnswerSpecification(),
      processor: {
        apply({ event }) {
          if (event.producerId !== voiceWriterAgent.getId()) return;
          const state = resolveRuntime().state;
          const task = state.activeVoiceTask;
          if (!task) return;
          const fragment = state.fragments.get(task.fragmentId);
          if (!fragment) return;

          if (task.phase === "plan") {
            fragment.voicePlan = answerText(event.payload.answer).trim();
            fragment.voicePlanStatus = "done";
            fragment.voicePlannedAt = Date.now();
            console.log(`⏱ #${fragment.id} Voice PLAN DONE +${delta(fragment)} ms`);
            console.log(`✅ Voice Writer PLAN DONE #${fragment.id}: ${fragment.voicePlan}`);
            state.voiceBusy = false;
            state.activeVoiceTask = null;
            queueVoiceDraft(fragment.id);
            startNextVoice(voiceWriterAgent);
            return;
          }

          if (task.phase === "draft") {
            fragment.voiceDraft = answerText(event.payload.answer).trim() || fragment.rawTranslation;
            fragment.voiceDraftStatus = "done";
            fragment.voiceDraftedAt = Date.now();
            console.log(`⏱ #${fragment.id} Voice DRAFT DONE +${delta(fragment)} ms`);
            console.log(`✅ Voice Writer DRAFT DONE #${fragment.id}: ${fragment.voiceDraft}`);
            state.voiceBusy = false;
            state.activeVoiceTask = null;
            queueVoiceFinal(fragment.id);
            startNextVoice(voiceWriterAgent);
            return;
          }

          fragment.spokenText = answerText(event.payload.answer).trim() || fragment.finalText;
          fragment.voiceStatus = "done";
          fragment.voiceCompletedAt = Date.now();
          console.log(`⏱ #${fragment.id} Voice VERIFY DONE +${delta(fragment)} ms`);
          console.log(`✅ Voice Writer VERIFY DONE #${fragment.id}: ${fragment.spokenText}`);
          state.voiceBusy = false;
          state.activeVoiceTask = null;
          publishCustomEvent("voice.ready", voiceWriterAgent, { fragmentId: fragment.id });
          startNextVoice(voiceWriterAgent);
        },
      },
    },
  ],
});
