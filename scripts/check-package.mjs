// Pre-publish check for the npm package: packs the library, verifies the
// tarball, installs it into an empty project and uses it from there, the way a
// consumer would. Needs network access for the install (to fetch dependencies).
// Nothing is published; the tarball stays in a temporary directory.
//
//   npm run check:package
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const work = await mkdtemp(path.join(tmpdir(), "irail-planner-pack-"));
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

try {
  // 1. The tarball holds the library and nothing else.
  const [packed] = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", work], root),
  );
  const files = new Set(packed.files.map((file) => file.path));
  const forbidden = [...files].filter((file) =>
    /^(test|playground|scripts|dist|coverage|node_modules)\//u.test(file),
  );
  assert.deepEqual(forbidden, [], "the tarball must not contain development files");
  for (const required of ["package.json", "README.md", "LICENSE"])
    assert.ok(files.has(required), `missing ${required}`);
  // Every entry point and type declaration the manifest promises.
  const targets = new Set([pkg.main, pkg.types]);
  const collect = (value) => {
    if (typeof value === "string") targets.add(value);
    else if (value) Object.values(value).forEach(collect);
  };
  collect(pkg.exports);
  for (const target of targets)
    if (target.startsWith("./"))
      assert.ok(files.has(target.slice(2)), `${target} is promised but not packed`);
  // Every local import inside the packed sources resolves inside the tarball.
  for (const file of files) {
    if (!/^src\/.*\.(mjs|mts)$/u.test(file)) continue;
    const source = await readFile(path.join(root, file), "utf8");
    for (const [, specifier] of source.matchAll(/from\s+"(\.\/[^"]+)"/gu))
      assert.ok(
        files.has(path.posix.join(path.posix.dirname(file), specifier)),
        `${file} imports ${specifier}, which is not packed`,
      );
  }
  console.log(`tarball ok: ${packed.filename}, ${files.size} files, ${packed.size} bytes`);

  // 2. It installs and works from a clean project.
  const consumer = path.join(work, "consumer");
  run("mkdir", [consumer], work);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error", path.join(work, packed.filename)],
    consumer,
  );
  await writeFile(
    path.join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as library from "${pkg.name}";
import * as browser from "${pkg.name}/browser";
import * as core from "${pkg.name}/core";
import manifest from "${pkg.name}/package.json" with { type: "json" };

assert.equal(typeof library.createPlanner, "function");
assert.equal(library.LC_VERSION, "2-alpha");
assert.equal(typeof browser.PlannerClient, "function");
assert.equal(typeof browser.createPlannerWorker, "function");
assert.equal(typeof core.createPlanner, "function");

const planner = library.createPlanner({ dataUrl: "https://example.org/manifest.jsonld" });
for (const call of ["init", "plan", "isochrone", "stations", "liveboard", "connections", "vehicle", "composition", "disturbances", "occupancyFeedback"])
  assert.equal(typeof planner[call], "function", call);
for (const call of ["stations", "liveboard", "connections", "vehicle", "composition", "disturbances", "occupancyFeedback"])
  assert.equal(typeof browser.PlannerClient.prototype[call], "function", "PlannerClient." + call);

// Calls whose data source is not supported yet say so.
for (const call of ["composition", "disturbances", "occupancyFeedback"]) {
  const error = await planner[call]({}).catch((e) => e);
  assert.ok(error instanceof library.NotSupportedError, call);
  assert.equal(error.status, 501);
}
// Calls that need the timetable ask for init first.
const early = await planner.liveboard({ station: "Gent-Sint-Pieters" }).catch((e) => e);
assert.ok(early instanceof library.IrailApiError);
assert.equal(early.status, 400);
console.log("consumer ok: " + manifest.name + "@" + manifest.version);
`,
  );
  process.stdout.write(run("node", ["smoke.mjs"], consumer));
} finally {
  await rm(work, { recursive: true, force: true });
}
