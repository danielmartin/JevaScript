import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createJev } from '../dist/client.js';
import { createProject, ts } from '../src/project.mjs';

test('recorded inference replays without HTTP, reapplies policy, and rejects drift or invalid answers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeva-recording-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'decisions.jsonl');
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    for await (const _ of req) { /* Drain the request before responding. */ }
    res.end(JSON.stringify({ answers: { result: { type: 'noul', noul: 0.8, confidence: 0.8 } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/predict`;
  const live = createJev({ endpoint, recordPath: filename, model: 'test fixture, not inference' });
  const first = live('Ready?', { a: 1, b: 2 }, { threshold: 0.9 });
  await assert.rejects(live('Concurrent?', {}), /sequential/);
  assert.equal(await first, false);
  assert.equal(requests, 1);
  const entry = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(entry.request, { state: { a: 1, b: 2 }, questions: { result: { type: 'noul', instructions: 'Ready?' } } });
  assert.equal(entry.answers.result.noul, 0.8);
  assert.equal(entry.model, 'test fixture, not inference');
  assert.throws(() => createJev({ recordPath: filename }), /EEXIST/);
  assert.throws(() => createJev({ recordPath: filename, replayPath: filename }), /not both/);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));

  const replay = createJev({ endpoint, replayPath: filename });
  assert.throws(() => replay.finishReplay(), /unused/);
  await assert.rejects(replay('Changed?', { a: 1, b: 2 }), /mismatch/);
  await assert.rejects(replay('Ready?', { a: 2, b: 2 }), /mismatch/);
  await assert.rejects(replay('Ready?', { a: 1, b: 2 }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  // Same inference, different application threshold. Object key order is irrelevant.
  assert.equal(await replay('Ready?', { b: 2, a: 1 }, { threshold: 0.7 }), true);
  replay.finishReplay();
  await assert.rejects(replay('Ready?', { a: 1, b: 2 }), /mismatch/);
  assert.equal(requests, 1);

  entry.answers.result.noul = 1.1;
  fs.writeFileSync(filename, JSON.stringify(entry) + '\n');
  await assert.rejects(createJev({ replayPath: filename })('Ready?', { a: 1, b: 2 }), /between 0 and 1/);
});

test('showcase replay runs without a model and retains the exact authorization guard', () => {
  const env = { ...process.env, JEVA_PYTHON: '/no-python', JEVA_MODEL: '/no-model', JEVA_RECORD: '', JEVA_REPLAY: '' };
  const run = extra => spawnSync(process.execPath, ['src/cli.mjs', 'run', 'examples/decision-audit.jeva',
    '--replay', 'examples/recordings/decision-audit.jsonl', '--trace'], {
    encoding: 'utf8', env: { ...env, ...extra }, timeout: 30_000,
  });
  const normal = run({ TRAVEL_REVIEW_THRESHOLD: '0.90' });
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stderr, /no model loaded/);
  assert.doesNotMatch(normal.stderr, /Starting Refli/);
  assert.match(normal.stdout, /PREPARE/);
  assert.match(normal.stdout, /HUMAN REVIEW/);
  assert.match(normal.stdout, /SIGN IN.*No model decision requested/);
  assert.match(normal.stdout, /A confident route may still be wrong/);
  const strict = run({ TRAVEL_REVIEW_THRESHOLD: '0.95' });
  assert.equal(strict.status, 0, strict.stderr);
  assert.match(strict.stdout, /HUMAN REVIEW: travel notification/);
  assert.match(strict.stdout, /PREPARE book flight/);
  assert.equal((strict.stdout.match(/HUMAN REVIEW/g) ?? []).length, 2);
  const bad = run({ TRAVEL_REVIEW_THRESHOLD: 'NaN' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be between/);
  const regression = spawnSync(process.execPath, ['src/cli.mjs', 'run', 'examples/decision-regression.jeva',
    '--replay', 'examples/recordings/decision-regression.jsonl'], { encoding: 'utf8', env, timeout: 30_000 });
  assert.equal(regression.status, 0, regression.stderr);
  assert.match(regression.stdout, /PASS checkout-impact/);
  assert.match(regression.stdout, /PASS still-confused/);
});

test('the showcase preserves TypeScript narrowing across a .ts import', () => {
  const filename = path.resolve('examples/decision-audit.jeva');
  const project = createProject([filename]);
  try {
    assert.deepEqual(project.diagnostics(), []);
    const source = fs.readFileSync(filename, 'utf8').replace(
      '// result.tool is a type error here: ordinary TS requires narrowing first.',
      'console.log(result.tool);',
    );
    project.update(filename, source);
    const diagnostics = project.diagnostics();
    assert.ok(diagnostics.some(d => d.code === 2339 && ts.flattenDiagnosticMessageText(d.messageText, '\n').includes("'tool'")));
  } finally { project.dispose(); }
});
