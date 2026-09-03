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
  const safe = text.replace(/[&|<>^%"`]/g, ' ').slice(0, 3500)
  const r = spawnSync('cmd.exe', ['/c', 'openclaw', 'message', 'send', '--channel', 'telegram',
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
  const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8')
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
    writeFileSync(join(dir, 'DONE'), `${code}\n`)
    log(dir, `claude exit=${code} killed=${killed}`)
    const head = `Builder ${meta(dir).name} finished exit=${code}${killed ? ' (killed by timer)' : ''}${cost}\nReport: ${join(dir, 'report.md')}\n\n`
    telegram(args.notify, head + result, dir)
    process.exit(0)
  })
}

function meta(dir) { try { return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) } catch { return { name: '?' } } }

if (cmd !== 'launch' && cmd !== 'run') {
  console.error('usage: detached-builder.mjs launch|run ...'); process.exit(2)
}
