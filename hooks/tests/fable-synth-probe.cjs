#!/usr/bin/env node
// Self-check for agent-model-guard: Fable synthesizer rules in Workflow scripts.
// Run: node hooks/tests/fable-synth-probe.cjs  (exit 1 on any mismatch)
const { spawnSync } = require("child_process");
const path = require("path");
const HOOK = path.join(__dirname, "..", "agent-model-guard.cjs");
const F = "{model: 'fable'}";
const cases = [
  ["synth after pipeline, top-level await", "allow",
   `const r = await pipeline(items, i => agent('a', {model:'opus'}), x => agent('b', {model:'sonnet'}));\nconst out = await agent('synth', ${F});\nreturn out;`],
  ["synth after parallel(map), top-level await", "allow",
   `const r = await parallel(items.map(i => () => agent('a', {model:'haiku'})));\nconst out = await agent('synth', ${F});`],
  ["fable inside map", "deny", `const r = await parallel(items.map(i => () => agent('a', ${F})));`],
  ["fable inside for loop", "deny", `for (const i of items) { await agent('a', ${F}) }`],
  ["hoisted single-line arrow helper", "deny",
   `const spawn = async () => await agent('a', ${F});\nfor (const i of items) { await spawn() }`],
  ["hoisted braced helper", "deny",
   `async function spawn() { return await agent('a', ${F}); }\nfor (const i of items) { await spawn() }`],
  ["fable without await", "deny", `const p = agent('a', ${F});\nfor (const i of items) {}`],
  ["4 top-level fable sites (cap 3)", "deny",
   Array.from({length:4}, (_,i) => `const s${i} = await agent('j', ${F});`).join("\n")],
  ["bare agent() no model", "deny", `const out = await agent('synth');`],
];
let fail = 0;
for (const [name, want, script] of cases) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Workflow", session_id: "probe", tool_input: { script } }),
    encoding: "utf8", env: { ...process.env, AGENT_GUARD_FABLE_CAP: "3" },
  });
  const got = /"deny"/.test(r.stdout) ? "deny" : "allow";
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${want.padEnd(5)} ${name}`);
}
console.log(`${cases.length - fail} of ${cases.length} cases match`);
process.exit(fail ? 1 : 0);
