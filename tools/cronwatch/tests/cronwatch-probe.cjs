#!/usr/bin/env node
'use strict';
// cronwatch-probe.cjs — classification and verdict against fixture JSON, no
// Task Scheduler. Run: node tools/cronwatch/tests/cronwatch-probe.cjs
// Written 2026-11-09 after CronwatchDaily was red every morning: the RUNNING
// constants were off by 512 (266497 = 0x41101, not 0x41301 = 267009), and the
// verdict counted Windows' own tasks and the board itself.

const assert = require('assert');
const { parseTasks, verdictTasks, decodeResult } = require('../cronwatch.cjs');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    console.error(`  \u2717 ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const row = (over) =>
  Object.assign(
    {
      TaskName: 'T',
      TaskPath: '\\',
      State: 'Ready',
      LastRunTime: '2026-11-09T05:50:01-05:00',
      LastTaskResult: 0,
      NextRunTime: '2026-11-10T05:50:00-05:00',
      Actions: [{ Execute: 'node.exe', Arguments: 'x.cjs' }],
    },
    over
  );
const classify = (over) => parseTasks(JSON.stringify([row(over)]))[0].classification;

test('0x41301 (267009) is RUNNING, not FAILED', () => {
  assert.strictEqual(classify({ State: 'Running', LastTaskResult: 267009 }), 'RUNNING');
  assert.strictEqual(decodeResult(267009).text, 'running (0x41301)');
});
test('0x41300 (267008) ready-waiting is OK', () => {
  assert.strictEqual(classify({ LastTaskResult: 267008 }), 'OK');
});
test('the old wrong constants are no longer special', () => {
  assert.strictEqual(classify({ LastTaskResult: 266497 }), 'FAILED');
  assert.strictEqual(decodeResult(266497).text, 'error 0x41101');
});
test('State=Running with 0x800710E0 (IgnoreNew daemon, keepalive refused) is RUNNING', () => {
  assert.strictEqual(classify({ State: 'Running', LastTaskResult: -2147020576 }), 'RUNNING');
});
test('State=Ready with 0x800710E0 is FAILED (a one-shot that never ran)', () => {
  assert.strictEqual(classify({ LastTaskResult: -2147020576 }), 'FAILED');
});
test('0x41303 never-run, exit 1, Disabled', () => {
  assert.strictEqual(classify({ LastTaskResult: 267011 }), 'NEVER-RUN');
  assert.strictEqual(classify({ LastTaskResult: 1 }), 'FAILED');
  assert.strictEqual(classify({ State: 'Disabled', LastTaskResult: 1 }), 'DISABLED');
});
test('verdict: Microsoft paths and the board itself render but do not count', () => {
  const tasks = parseTasks(
    JSON.stringify([
      row({ TaskName: 'Windows Defender Scheduled Scan', TaskPath: '\\Microsoft\\Windows\\Windows Defender\\', LastTaskResult: 2 }),
      row({ TaskName: 'CronwatchDaily', Actions: [{ Execute: 'node.exe', Arguments: '"C:\\x\\tools\\cronwatch\\cronwatch.cjs" --all' }], LastTaskResult: 1 }),
      row({ TaskName: 'moneyme reply watcher', LastTaskResult: 1 }),
      row({ TaskName: 'mole-daemon', State: 'Running', LastTaskResult: -2147020576 }),
      row({ TaskName: 'fine', LastTaskResult: 0 }),
    ])
  );
  assert.strictEqual(tasks.filter((t) => t.classification === 'FAILED').length, 3, 'three FAILED rows render');
  assert.deepStrictEqual(verdictTasks(tasks).map((t) => t.name), ['moneyme reply watcher'], 'one decides the exit code');
});
test('verdict is empty when only Microsoft and the board are red', () => {
  const tasks = parseTasks(
    JSON.stringify([
      row({ TaskName: 'StorageSense', TaskPath: '\\Microsoft\\Windows\\DiskFootprint\\', LastTaskResult: -2147221164 }),
      row({ TaskName: 'CronwatchDaily', Actions: [{ Execute: 'node.exe', Arguments: 'cronwatch.cjs --all' }], LastTaskResult: 1 }),
    ])
  );
  assert.strictEqual(verdictTasks(tasks).length, 0);
});

console.log(`cronwatch-probe: ${passed} passed${process.exitCode ? ', FAILED' : ''}`);
