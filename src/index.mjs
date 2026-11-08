import { tableFromIPC, RecordBatchReader } from "apache-arrow";
import { createPlanner as createPlannerCore } from "./planner-core.mjs";
import { createPlannerService } from "./planner-service.mjs";
import { addIrailMethods } from "./irail-methods.mjs";
import { addRealtimeMethods } from "./realtime-watch.mjs";

export { LC_VERSION } from "./lc-timetable.mjs";
export { IrailApiError, NotSupportedError } from "./irail-errors.mjs";
export { RealtimeWatcher } from "./realtime-watch.mjs";

/** A planner instance owns its reference tables and bounded connection cache. */
export class Planner {
  constructor({ dataUrl, fetch, cacheBytes } = {}) {
    this.dataUrl = dataUrl;
    this.sources = [];
    this.handle = createPlannerService(
      createPlannerCore(
        { tableFromIPC, RecordBatchReader },
        { fetch, cacheBytes },
      ),
    );
    this.queue = Promise.resolve();
  }

  request(type, payload, onProgress) {
    const request = this.queue.then(() =>
      this.handle(type, payload, onProgress),
    );
    this.queue = request.catch(() => {});
    return request;
  }

  async init(dataUrl = this.dataUrl, { realtime = true } = {}) {
    if (!dataUrl) throw new Error("Provide an absolute LC 2.0-alpha dataUrl");
    this.sources = await this.request("init", { dataUrl, realtime });
    this.dataUrl = dataUrl;
    return this.sources;
  }

  plan(query, onProgress) {
    return this.request("plan", { maxWalkMeters: 1000, ...query }, onProgress);
  }

  isochrone(query, onProgress) {
    return this.request(
      "isochrone",
      { maxWalkMeters: 1000, ...query },
      onProgress,
    );
  }
}

addIrailMethods(Planner.prototype);
addRealtimeMethods(Planner.prototype);

export function createPlanner(options) {
  return new Planner(options);
}
