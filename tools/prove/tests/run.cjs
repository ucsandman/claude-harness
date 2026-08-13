#!/usr/bin/env node
// tests/run.cjs — self-test for prove.cjs.
// Runs prove twice against the fixture and asserts the expected verdicts,
// then asserts the fixture file was left byte-identical and no backup remains.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const proveScript = path.join(__dirname, '..', 'prove.cjs');
const fixtureDir = path.join(__dirname, 'fixture');
const targetFile = path.join(fixtureDir, 'target.cjs');
const backupFile = `${targetFile}.prove-bak`;

function hashOf(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runProve(find, replace) {
  return spawnSync(
    process.execPath,
    [
      proveScript,
      '--check',
      'node check.cjs',
      '--file',
      targetFile,
      '--find',
      find,
      '--replace',
      replace,
      '--cwd',
      fixtureDir,
    ],
    { encoding: 'utf8' }
  );
}

const originalHash = hashOf(targetFile);
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS: ${name}`);
  } else {
    failures++;
    console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// --- case 1: mutating the logic must be caught (VERIFIED, exit 0) ---
{
  const result = runProve('a + b', 'a - b');
  check(
    'case 1 (logic mutation) exits 0 (VERIFIED)',
    result.status === 0,
    `exit code was ${result.status}\n${result.stdout}\n${result.stderr}`
  );
  check(
    'case 1 fixture restored byte-identical',
    hashOf(targetFile) === originalHash
  );
  check('case 1 no leftover backup file', !fs.existsSync(backupFile));
}

// --- case 2: mutating an unrelated comment must NOT be caught (UNVERIFIED, exit 1) ---
{
  const result = runProve('prove-fixture marker', 'prove-fixture marker moved');
  check(
    'case 2 (comment mutation) exits 1 (UNVERIFIED)',
    result.status === 1,
    `exit code was ${result.status}\n${result.stdout}\n${result.stderr}`
  );
  check(
    'case 2 fixture restored byte-identical',
    hashOf(targetFile) === originalHash
  );
  check('case 2 no leftover backup file', !fs.existsSync(backupFile));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks PASSED');
  process.exit(0);
}
