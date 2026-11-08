import { addIrailMethods } from "./irail-methods.mjs";
import { IrailApiError } from "./irail-errors.mjs";
import { addRealtimeMethods } from "./realtime-watch.mjs";

// Only stop-search metadata and completed journeys cross the worker boundary.
export class PlannerClient {
  constructor(worker) {
    this.worker = worker;
    this.pending = new Map();
    this.nextId = 0;
    worker.addEventListener("message", ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      if (data.type === "progress") {
        request.onProgress?.(data.progress);
        return;
      }
      this.pending.delete(data.id);
      if (data.type === "error")
        request.reject(
          data.status
            ? new IrailApiError(data.status, data.error)
            : new Error(data.error),
        );
      else request.resolve(data.result);
    });
    const fail = (event) => {
      this.failure = new Error(
        event.message || "Planner worker failed to communicate",
      );
      for (const request of this.pending.values()) request.reject(this.failure);
      this.pending.clear();
      worker.terminate();
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
  }

  request(type, payload, onProgress) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        this.worker.postMessage({ id, type, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.failure = new Error("Planner client closed");
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    this.worker.terminate();
  }
}

addIrailMethods(PlannerClient.prototype);
addRealtimeMethods(PlannerClient.prototype);
