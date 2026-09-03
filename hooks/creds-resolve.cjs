// SessionStart: if the project has .env.example, fill .env from the local
// creds vault before the agent can ask Wes for a key. Never overwrites set keys.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let cwd = process.cwd();
try { const j = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); if (j.cwd) cwd = j.cwd; } catch {}

const out = ["creds vault is installed: before asking Wes for ANY API key, token, or account, run `creds resolve` (fills .env from keys already on this machine) and `creds mint <provider>` (exact page + steps). Only a key that survives both goes to Wes."];
if (fs.existsSync(path.join(cwd, ".env.example"))) {
  const r = spawnSync("creds", ["resolve", cwd], { encoding: "utf8", shell: true, timeout: 8000 });
  const text = (r.stdout || "") + (r.stderr || "");
  if (text.trim()) out.push("creds resolve ran for this project:\n" + text.trim());
}
process.stdout.write(out.join("\n"));
