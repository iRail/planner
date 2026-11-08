import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { PlannerClient } from "../../src/planner-client.mjs";
const require = createRequire(import.meta.url);
export async function startWorker(directory) {
  const bootstrap = `
    const { parentPort, Worker: NodeWorker, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const path = require("node:path");
    const { pathToFileURL, fileURLToPath } = require("node:url");
    const bootstrap = workerData.bootstrap;
    global.self = {
      addEventListener: (_, handler) => parentPort.on("message", data => handler({data})),
      postMessage: (data, transfer) => parentPort.postMessage(data, transfer),
    };
    global.Worker = class {
      constructor(url) {
        this.worker = new NodeWorker(bootstrap, {eval: true, workerData: {...workerData, entry: url.href}});
      }
      addEventListener(type, handler) {
        this.worker.on(type, type === "message" ? data => {
          if (data.fetched) parentPort.postMessage(data);
          else handler({data});
        } : handler);
      }
      postMessage(data, transfer) { this.worker.postMessage(data, transfer); }
      terminate() { return this.worker.terminate(); }
    };
    global.fetch = async url => {
      parentPort.postMessage({ fetched: url });
      try { return new Response(await fs.promises.readFile(path.join(workerData.directory, /^https?:/.test(url) ? new URL(url).pathname.slice("/data/".length) : url))); }
      catch { return new Response("missing", {status:404}); }
    };
    let entry = fs.readFileSync(fileURLToPath(workerData.entry), "utf8");
    entry = entry.replaceAll('"apache-arrow"', JSON.stringify(workerData.arrow));
    entry = entry.replace(/from "(\\.\\/[^"]+)"/g, (_, specifier) => 'from ' + JSON.stringify(new URL(specifier, workerData.entry).href));
    entry = entry.replaceAll("import.meta.url", JSON.stringify(workerData.entry));
    import('data:text/javascript;base64,' + Buffer.from(entry).toString('base64')).catch(error => {throw error;});
  `;
  const worker = new Worker(bootstrap, {
    eval: true,
    workerData: {
      bootstrap,
      directory,
      entry: new URL("../../src/planner-worker.mjs", import.meta.url).href,
      arrow: pathToFileURL(require.resolve("apache-arrow")).href,
    },
  });
  const fetched = [];
  worker.on("message", (data) => {
    if (data.fetched) fetched.push(data.fetched);
  });
  const adapter = {
    addEventListener(type, listener) {
      worker.on(
        type,
        type === "message" ? (data) => listener({ data }) : listener,
      );
    },
    postMessage: (data) => worker.postMessage(data),
    terminate: () => worker.terminate(),
  };
  return { client: new PlannerClient(adapter), fetched, worker };
}
