import { defineRuntime, RuntimeState } from "@mozaik-ai/core";

export class TranslatorState extends RuntimeState {
  constructor({ sourceLanguage = "ru", targetLanguage = "en" } = {}) {
    super();
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.fragments = new Map();
    this.translationQueue = [];
    this.editQueue = [];
    this.translationBusy = false;
    this.editBusy = false;
    this.activeTranslationFragmentId = null;
    this.activeEditFragmentId = null;
  }

  createFragment(id, sourceText) {
    const fragment = {
      id,
      sourceText,
      rawTranslation: null,
      finalText: null,
      sttStatus: "done",
      translationStatus: "pending",
      editingStatus: "pending",
      createdAt: Date.now(),
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
