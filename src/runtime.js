import { defineRuntime, RuntimeState } from "@mozaik-ai/core";

export class TranslatorState extends RuntimeState {
  constructor({ sourceLanguage = "ru", targetLanguage = "en" } = {}) {
    super();
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.fragments = new Map();
    this.sourceQueue = [];
    this.translationQueue = [];
    this.editQueue = [];
    this.sourceBusy = false;
    this.translationBusy = false;
    this.editBusy = false;
    this.activeSourceFragmentId = null;
    this.activeTranslationFragmentId = null;
    this.activeEditFragmentId = null;
  }

  createFragment(id, sourceText) {
    const fragment = {
      id,
      rawSourceText: sourceText,
      sourceText,
      rawTranslation: null,
      finalText: null,
      sttStatus: "normalizing",
      translationStatus: "pending",
      editingStatus: "pending",
      createdAt: Date.now(),
      normalizedAt: null,
      translatedAt: null,
      completedAt: null,
    };
    this.fragments.set(id, fragment);
    return fragment;
  }
}

export const {
  initializeRuntime,
  resolveRuntime,
  join,
  sendEvent,
  runLoop,
} = defineRuntime();
