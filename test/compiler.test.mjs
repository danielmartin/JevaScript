import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createProject, ts } from '../src/project.mjs';
const require = createRequire(import.meta.url);
const upstream = require('typescript');
const text = diagnostics => diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');

test('parser handles real TS grammar, lowering, type checking, and preserved source locations', () => {
  const project = createProject();
  const filename = path.resolve('test/fixture.jeva');
  const source = `
interface Ticket { body: string }
const ticket: Ticket = { body: 'refund' };
const regex = /decide \\(.*\\) \\{[^}]*\\}/g;
const template = \`value: \${ticket.body} decide (x) {}\`;
// decide ('ignored', {}) {}
async function run<T extends Ticket>(value: T) {
  decide ('Refund?', { text: value.body }).threshold(0.85).and('Urgent?', { text: template }) {
    decide ('Again?', {}) { console.log(regex); } else { console.log('no'); }
  } else { console.log('standard'); }
  decide.route('Team?', { criteria: ['billing', 'technical'], state: {} }) {
    case 'billing': break;
    case 'technical': break;
  }
  let tries = 0;
  while (tries++ < 2 && decide('Continue?', {})) { console.log(tries); }
  const score: number = decide.score('Severity?', { criteria: ['low', 'high'], state: {} });
  decide.assert('Polite?', {}).threshold(0.8);
  return score;
}
await run(ticket);
`;
  project.update(filename, source);
  assert.equal(text(project.diagnostics()), '');
  const parsed = project.service.getProgram().getSourceFile(filename + '.ts');
  const printed = ts.createPrinter().printFile(parsed);
  assert.match(printed, /if \(await decide/);
  assert.match(printed, /&& await decide/);
  assert.match(printed, /switch \(await decide.route/);
  assert.match(printed, /while \(tries\+\+ < 2 && await decide/);
  assert.match(printed, /const score: number = await decide.score/);

  for (const [bad, expected] of [
    ["function sync() { decide ('Q?', {}) {} }", /await.*async/s],
    ["decide.route('Q?', {criteria: ['a', 'b'], state: {}}) { case 'c': break; }", /not comparable/],
    ["const result: string = decide.score('Q?', {criteria: ['a', 'b'], state: {}});", /number.*string/s],
    ["decide ('Q?', {}).threshold(2) {}", /between 0 and 1/],
    ["const decide = () => true;", /cannot be redeclared/],
    ["decide ('Q?', 123) {}", /not assignable/],
    ["decide.unknown('Q?', {});", /Unknown decision operation/],
    ["decide.score('Q?', {criteria:['a','b'],state:{}}).and('B?', {});", /only boolean/],
    ["const t = 0.8; decide('A?', {}).and('B?', {}).threshold(t) {}", /numeric literal/],
  ]) {
    project.update(filename, bad);
    assert.match(text(project.diagnostics()), expected, bad);
  }
  project.update(filename, "\n\nconst number: number = 'bad';");
  const error = project.diagnostics().find(d => d.code === 2322);
  assert.equal(error.file.getLineAndCharacterOfPosition(error.start).line, 2);
  project.dispose();
});

test('emitted decisions execute branches, lazy chains, thresholds, bounded loops, routing, and errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeva-execute-'));
  try {
    fs.writeFileSync(path.join(dir, 'fake.ts'), `
export const events: string[] = [];
export const decide = Object.assign(async (question: string, state: { probability: number }, options?: {threshold: number}) => {
  events.push(question);
  if (question === 'fail') throw new Error('inference unavailable');
  return state.probability >= (options?.threshold ?? 0.5);
}, {route: async () => 'billing', score: async () => 0.75});
`);
    const filename = path.join(dir, 'main.jeva');
    fs.writeFileSync(filename, `
import assert from 'node:assert/strict';
import { events } from './fake.ts';
let states = 0;
function state() { states++; return { probability: 0.9 }; }
decide ('first', { probability: 0.1 }).and('skipped', state()).threshold(0.85) {
  throw new Error('wrong branch');
} else { events.push('else'); }
assert.equal(states, 0);
assert.deepEqual(events, ['first', 'else']);
decide ('first passes', { probability: 0.9 }).and('second fails', { probability: 0.7 }).threshold(0.85) {
  throw new Error('shared threshold was lost');
}
decide ('last threshold wins', { probability: 0.7 }).threshold(0.6).threshold(0.8) {
  throw new Error('earlier threshold won');
}
let thresholdCalls = 0;
function threshold() { thresholdCalls++; return 0.8; }
decide ('dynamic threshold', { probability: 0.7 }).threshold(threshold()) {
  throw new Error('dynamic threshold was lost');
}
assert.equal(thresholdCalls, 1);
let attempts = 0;
while (attempts < 2 && decide('repeat', { probability: 1 })) { attempts++; }
assert.equal(attempts, 2);
let team = '';
decide.route('team', {criteria:['billing', 'technical'],state:{}}) { case 'billing': team = 'billing'; break; default: team = 'technical'; }
assert.equal(team, 'billing');
assert.equal(decide.score('severity', {criteria:['low','high'],state:{}}), 0.75);
let caught = false;
try { decide('fail', {probability: 1}) {} else { throw new Error('errors must not become false'); } }
catch (error) { caught = error instanceof Error && error.message === 'inference unavailable'; }
assert.ok(caught);
console.log('execution checks passed');
`);
    const project = createProject([filename], dir);
    const result = project.build();
    assert.equal(text(result.diagnostics), '');
    const output = result.outputs.get(filename);
    const fake = pathToFileURL(result.outputs.get(path.join(dir, 'fake.ts'))).href;
    const emitted = fs.readFileSync(output, 'utf8').replace(/file:\/\/[^"\n]+\/runtime\/runtime\.mjs/, fake);
    fs.writeFileSync(output, emitted);
    assert.match(execFileSync(process.execPath, ['--enable-source-maps', output], {encoding:'utf8'}), /execution checks passed/);
    const original = fs.readFileSync(filename, 'utf8');
    const errorLine = original.split('\n').length;
    const failing = original + "throw new Error('source map check');\n";
    fs.writeFileSync(filename, failing);
    project.update(filename, failing);
    const rebuilt = project.build();
    assert.equal(text(rebuilt.diagnostics), '');
    fs.writeFileSync(output, fs.readFileSync(output, 'utf8').replace(/file:\/\/[^"\n]+\/runtime\/runtime\.mjs/, fake));
    const failure = spawnSync(process.execPath, ['--enable-source-maps', output], {encoding:'utf8'});
    assert.equal(failure.status, 1);
    assert.ok(failure.stderr.includes(`main.jeva:${errorLine}:`), failure.stderr);
    project.dispose();
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('ordinary .ts parsing remains unchanged', () => {
  const source = "function decide(x: boolean) { return x; } if (decide(true)) console.log('yes');";
  const a = ts.createSourceFile('plain.ts', source, ts.ScriptTarget.Latest, true);
  const b = upstream.createSourceFile('plain.ts', source, upstream.ScriptTarget.Latest, true);
  assert.equal(ts.createPrinter().printFile(a), upstream.createPrinter().printFile(b));
  assert.deepEqual(a.parseDiagnostics, b.parseDiagnostics);
});

test('multi-file imports compile and source maps refer to original JevaScript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeva-compiler-'));
  try {
    fs.writeFileSync(path.join(dir, 'helper.jeva'), "export const message: string = 'hello';");
    fs.writeFileSync(path.join(dir, 'main.jeva'), "import { message } from './helper.jeva';\nconsole.log(message);\ndecide ('Q?', {message}) {}\n");
    const project = createProject([path.join(dir, 'main.jeva')], dir);
    const result = project.build();
    assert.equal(text(result.diagnostics), '');
    const main = fs.readFileSync(result.outputs.get(path.join(dir, 'main.jeva')), 'utf8');
    assert.match(main, /helper.jeva.js/);
    assert.match(main, /import \{ decide \}/);
    const map = JSON.parse(fs.readFileSync(result.outputs.get(path.join(dir, 'main.jeva')) + '.map'));
    assert.ok(map.sources.some(source => source.endsWith('main.jeva')));
    assert.ok(map.sourcesContent[0].includes("decide ('Q?'"));
    project.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
