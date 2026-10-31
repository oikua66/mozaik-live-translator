import { defineRuntime, RuntimeState } from "@mozaik-ai/core";

export class CorporateNetworkState extends RuntimeState {
  constructor() {
    super();
    this.employees = new Map();
    this.personalAgents = new Map();
    this.activeModules = new Map();
    this.eventLog = [];
    this.sequence = 1;
  }

  log(type, message, details = {}) {
    const entry = {
      id: this.sequence++,
      type,
      message,
      details,
      at: Date.now(),
    };
    this.eventLog.push(entry);
    if (this.eventLog.length > 200) this.eventLog.shift();
    return entry;
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
