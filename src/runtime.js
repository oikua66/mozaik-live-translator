import { defineRuntime, RuntimeState } from "@mozaik-ai/core";

export class TranslatorState extends RuntimeState {
  constructor({ sourceLanguage = "ru", targetLanguage = "en", outputStyle = "polite" } = {}) {
    super();
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.outputStyle = outputStyle;
    this.fragments = new Map();
    this.sourceQueue = [];
    this.translationQueue = [];
    this.editQueue = [];
    this.voiceQueue = [];
    this.sourceBusy = false;
    this.translationBusy = false;
    this.editBusy = false;
    this.voiceBusy = false;
    this.activeSourceFragmentId = null;
    this.activeTranslationFragmentId = null;
    this.activeEditTask = null;
    this.activeVoiceTask = null;
  }

  createFragment(id, sourceText, timing = {}) {
    const fragment = {
      id,
      rawSourceText: sourceText,
      sourceText,
      rawTranslation: null,
      finalText: null,
      styleBrief: null,
      voicePlan: null,
      voiceDraft: null,
      spokenText: null,
      briefStatus: "pending",
      voicePlanStatus: "pending",
      voiceDraftStatus: "pending",
      voiceStatus: "pending",
      polishQueued: false,
      voiceDraftQueued: false,
      voiceFinalQueued: false,
      sttStatus: "normalizing",
      translationStatus: "pending",
      editingStatus: "pending",
      clientFinalAt: timing.clientFinalAt || null,
      serverReceivedAt: timing.serverReceivedAt || Date.now(),
      createdAt: Date.now(),
      normalizedAt: null,
      translatedAt: null,
      briefedAt: null,
      completedAt: null,
      voicePlannedAt: null,
      voiceDraftedAt: null,
      voiceCompletedAt: null,
    };
    this.fragments.set(id, fragment);
    return fragment;
  }
}

export const {
  initializeRuntime,
  resolveRuntime,
  join,
  leave,
  sendEvent,
  runLoop,
} = defineRuntime();
