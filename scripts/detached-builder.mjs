#!/usr/bin/env node
// Detached claude -p builder with a DONE file and a Telegram report.
// Why: Agent-tool builders spawned from an OpenClaw turn look dead on the next
// turn (see memory openclaw-subagent-lifecycle). This runs the builder in its
// own process tree, polls nothing, and reports by file + Telegram when it exits.
//
//   node detached-builder.mjs launch --name <slug> --cwd <dir> --prompt-file <path>
//        [--model claude-opus-4-8] [--effort xhigh] [--notify <telegram chat id>]
//        [--kill-minutes 240] [--allowed-tools "Bash,Read,Edit,Write,Glob,Grep,Agent,WebFetch,WebSearch"]
//   -> prints one-line JSON {ok, pid, dir}; the run dir holds prompt.md,
//      claude.out.json, claude.err.log, DONE (exit code), report.md
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(homedir(), '.claude', 'builders')
const args = parse(process.argv.slice(2))
const cmd = process.argv[2]

function parse(list) {
  const o = {}
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) { o[list[i].slice(2)] = list[i + 1] ?? ''; i++ }
  }
  return o
}
function need(k) { if (!args[k]) { console.error(`missing --${k}`); process.exit(2) } return args[k] }
function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
function log(dir, msg) {
  try { writeFileSync(join(dir, 'builder.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' }) } catch {}
}
function cleanEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_\w+|CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_EFFORT|CLAUDE_PLUGIN_DATA)$/.test(k)) delete env[k]
  }
  env.PYTHONUTF8 = '1'
  return env
}
function telegram(target, text, dir) {
  if (!target) return
  // Call the openclaw entry through node directly: cmd.exe drops everything after
  // the first newline, so multi-line reports arrived as a bare header (seen 2026-09-03).
  const safe = text.slice(0, 3500)
  const entry = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs')
  const r = spawnSync(process.execPath, [entry, 'message', 'send', '--channel', 'telegram',
    '--target', String(target), '--message', safe], { encoding: 'utf8', timeout: 60000, env: cleanEnv() })
  log(dir, `telegram exit=${r.status} ${String(r.stderr || '').slice(0, 200)}`)
}

if (cmd === 'launch') {
  const name = need('name').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const cwd = need('cwd'); const promptFile = need('prompt-file')
  if (!existsSync(cwd)) { console.error(`cwd missing: ${cwd}`); process.exit(2) }
  const dir = join(ROOT, `${name}-${stamp()}`)
  mkdirSync(dir, { recursive: true })
  copyFileSync(promptFile, join(dir, 'prompt.md'))
  const runArgs = [SELF, 'run', '--dir', dir, '--cwd', cwd,
    '--model', args.model || 'claude-opus-4-8', '--effort', args.effort || 'xhigh',
    '--notify', args.notify || '', '--kill-minutes', args['kill-minutes'] || '240',
    '--allowed-tools', args['allowed-tools'] || 'Bash,Read,Edit,Write,Glob,Grep,Agent,WebFetch,WebSearch,TodoWrite']
  const sup = spawn(process.execPath, runArgs, {
    detached: true, stdio: ['ignore', openSync(join(dir, 'supervisor.log'), 'a'), openSync(join(dir, 'supervisor.log'), 'a')],
    env: cleanEnv(), windowsHide: true,
  })
  sup.unref()
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name, cwd, model: args.model || 'claude-opus-4-8', supervisor_pid: sup.pid, started_at: new Date().toISOString() }, null, 2))
  console.log(JSON.stringify({ ok: true, pid: sup.pid, dir }))
  process.exit(0)
}

if (cmd === 'run') {
  const dir = need('dir'); const cwd = need('cwd')
  // Standing ground rules prepended to every builder brief (Wes, 2026-09-03: the
  // TradesDesk builder wired @anthropic-ai/sdk because its brief never said not to).
  const GROUND_RULES = [
    'STANDING GROUND RULES (apply before the task below):',
    '- Model calls in anything you build run through the Claude Code CLI (claude -p) or Codex CLI on the monthly subscription. NEVER the Anthropic API, never @anthropic-ai/sdk or api.anthropic.com, never an ANTHROPIC_API_KEY. Strip env vars starting with CLAUDE or ANTHROPIC_ before spawning the CLI.',
    '- No em dashes in any copy, comments, or docs.',
    '- New projects live at C:\\Projects\\<slug>.',
    '- You are a one-shot claude -p run. The moment you end your turn the process exits and every background task, shell job, or child you started dies with it. NEVER use Bash run_in_background, Monitor, or "I will continue when it completes". Run long measurements in the foreground with an explicit timeout (split into chunks under 10 minutes each), read the output, and keep working until the whole brief is finished. (2026-09-04: a builder ended its turn waiting on a 27 minute background measurement and lost the rest of its work.)',
    '', '',
  ].join('\n')
  const prompt = GROUND_RULES + readFileSync(join(dir, 'prompt.md'), 'utf8')
  const outFd = openSync(join(dir, 'claude.out.json'), 'w')
  const errFd = openSync(join(dir, 'claude.err.log'), 'w')
  const claudeArgs = ['-p', '--model', args.model, '--effort', args.effort, '--output-format', 'json',
    '--permission-mode', 'acceptEdits', '--allowedTools', args['allowed-tools']]
  log(dir, `spawn claude cwd=${cwd} model=${args.model} effort=${args.effort}`)
  const child = spawn('claude', claudeArgs, { cwd, stdio: ['pipe', outFd, errFd], env: cleanEnv(), windowsHide: true })
  child.stdin.end(prompt)
  const killMs = Number(args['kill-minutes'] || 240) * 60000
  let killed = false
  const timer = setTimeout(() => {
    killed = true; log(dir, `kill timer ${killMs}ms fired`)
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' })
  }, killMs)
  child.on('error', (e) => { log(dir, `spawn error ${e.message}`) })
  child.on('close', (code) => {
    clearTimeout(timer)
    let result = ''; let cost = ''
    try {
      const j = JSON.parse(readFileSync(join(dir, 'claude.out.json'), 'utf8'))
      result = j.result || ''; cost = j.total_cost_usd != null ? ` est_cost=$${Number(j.total_cost_usd).toFixed(2)} (subscription, not billed)` : ''
    } catch (e) { result = `(no JSON result: ${e.message})` }
    writeFileSync(join(dir, 'report.md'), result)
    // Abandonment detector (2026-09-04): a claude -p run that ends its turn with a
    // promise ("I'll continue when the background job completes") has exited, and
    // its background work died with it. A short, promise-shaped result is a failure.
    const promise = /\b(i'?ll|i will|will) (continue|resume|check back|report back)\b|waiting (on|for) (the )?(background|measurement|job|process)|when it (completes|finishes)|fallback fires/i
    const abandoned = !killed && result.length < 600 && promise.test(result)
    writeFileSync(join(dir, 'DONE'), `${abandoned ? 'abandoned' : code}\n`)
    log(dir, `claude exit=${code} killed=${killed}${abandoned ? ' ABANDONED (ended turn with pending work)' : ''}`)
    const head = abandoned
      ? `Builder ${meta(dir).name} ABANDONED its work: it ended its turn waiting on a background job, so the process exited and the job died. Files may be on disk uncommitted. Relaunch from the worktree with a resume brief.${cost}\nReport: ${join(dir, 'report.md')}\n\n`
      : `Builder ${meta(dir).name} finished exit=${code}${killed ? ' (killed by timer)' : ''}${cost}\nReport: ${join(dir, 'report.md')}\n\n`
    telegram(args.notify, head + result, dir)
    process.exit(0)
  })
}

function meta(dir) { try { return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) } catch { return { name: '?' } } }

if (cmd !== 'launch' && cmd !== 'run') {
  console.error('usage: detached-builder.mjs launch|run ...'); process.exit(2)
}
