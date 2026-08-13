#!/usr/bin/env node
// prove.cjs — deliberately break the thing a check watches, confirm it goes
// red, restore, confirm it goes green again. Zero dependencies.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_LINES = 40;

// --- state used by the emergency (SIGINT/SIGTERM) restore path ---
let gFilePath = null;
let gOriginalBuffer = null;
let gBackupPath = null;
let gMutated = false;

function log(msg) {
  console.log(`[prove] ${msg}`);
}

function tail(text, n) {
  const lines = String(text || '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      args[key] = val;
      i++;
    }
  }
  return args;
}

function usageAndExit() {
  console.error(
    'usage: node prove.cjs --check "<shell command>" --file <path> --find "<literal string>" --replace "<literal string>" [--cwd <dir>]'
  );
  process.exit(2);
}

function runCheck(command, cwd) {
  const result = spawnSync(command, {
    shell: true,
    cwd,
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
  const status = result.error ? (result.status === null ? 1 : result.status) : result.status;
  return { status, combined, error: result.error };
}

function emergencyRestore() {
  try {
    if (gMutated && gFilePath && gOriginalBuffer) {
      fs.writeFileSync(gFilePath, gOriginalBuffer);
      gMutated = false;
    }
  } catch (e) {
    // best effort
  }
  try {
    if (gBackupPath && fs.existsSync(gBackupPath)) {
      fs.unlinkSync(gBackupPath);
    }
  } catch (e) {
    // best effort
  }
}

process.on('SIGINT', () => {
  emergencyRestore();
  process.exit(130);
});
process.on('SIGTERM', () => {
  emergencyRestore();
  process.exit(143);
});

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.check || !args.file || !args.find || args.replace === undefined) {
    usageAndExit();
  }

  const filePath = path.resolve(args.file);
  const cwd = args.cwd ? path.resolve(args.cwd) : path.dirname(filePath);

  if (!fs.existsSync(filePath)) {
    console.error(`SETUP FAILED: target file does not exist: ${filePath}`);
    process.exit(2);
  }

  // --- a. baseline ---
  const baseline = runCheck(args.check, cwd);
  if (baseline.status !== 0) {
    console.error('BASELINE FAILED: fix the check before proving it');
    console.error(tail(baseline.combined, TAIL_LINES));
    process.exit(2);
  }
  log('baseline ok');

  // --- b. read + backup ---
  const originalBuffer = fs.readFileSync(filePath);
  const originalText = originalBuffer.toString('utf8');

  if (!originalText.includes(args.find)) {
    console.error(
      `SETUP FAILED: --find string was not found in ${filePath}; file left untouched`
    );
    process.exit(2);
  }

  const backupPath = `${filePath}.prove-bak`;
  fs.writeFileSync(backupPath, originalBuffer);

  gFilePath = filePath;
  gOriginalBuffer = originalBuffer;
  gBackupPath = backupPath;

  let mutationResult = null;
  let mutationError = null;

  try {
    // --- c. mutate ---
    const mutatedText = originalText.split(args.find).join(args.replace);
    fs.writeFileSync(filePath, mutatedText, 'utf8');
    gMutated = true;
    log('mutation applied');

    // --- d. run check again, expect non-zero ---
    mutationResult = runCheck(args.check, cwd);
    if (mutationResult.status !== 0) {
      log('check went red');
    } else {
      log('check stayed green');
    }
  } catch (err) {
    mutationError = err;
    console.error(`ERROR while mutating/checking: ${err.message}`);
  } finally {
    // --- e. always restore ---
    let restoreWriteOk = true;
    try {
      fs.writeFileSync(filePath, originalBuffer);
      gMutated = false;
      log('restored');
    } catch (err) {
      restoreWriteOk = false;
      console.error(`RESTORE FAILED: could not write original bytes back to ${filePath}: ${err.message}`);
    }

    try {
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
        gBackupPath = null;
      }
    } catch (err) {
      console.error(`WARNING: could not delete backup file ${backupPath}: ${err.message}`);
    }

    if (!restoreWriteOk) {
      process.exit(2);
    }

    const restoreCheck = runCheck(args.check, cwd);
    if (restoreCheck.status !== 0) {
      console.error(`RESTORE FAILED: the restore-side rerun failed — check did not pass after restoring ${filePath}`);
      console.error(tail(restoreCheck.combined, TAIL_LINES));
      process.exit(2);
    }
    log('green again');
  }

  if (mutationError) {
    process.exit(2);
  }

  // --- f. verdict ---
  if (mutationResult.status !== 0) {
    console.log(`VERIFIED: ${args.check} goes red when ${filePath} is broken`);
    process.exit(0);
  } else {
    console.log(
      'UNVERIFIED: the check stayed green with the mutation applied — it does not watch what you think it watches'
    );
    process.exit(1);
  }
}

main();
