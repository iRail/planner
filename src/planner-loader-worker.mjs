import { RecordBatchReader } from "apache-arrow";
import { readConnectionBatches, buffersOf } from "./planner-data.mjs";

self.addEventListener("message", async ({ data }) => {
  try {
    const batches = await readConnectionBatches(RecordBatchReader, data);
    self.postMessage({ batches }, buffersOf(batches));
  } catch (error) {
    self.postMessage({ error: error.message });
  }
});
