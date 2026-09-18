import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

test('LSP stdio supports diagnostics, completion, hover, definitions, references, rename, and updates', async t => {
  const child = spawn(process.execPath, ['src/lsp.mjs', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  let buffer = Buffer.alloc(0);
  let id = 0;
  const requests = new Map();
  const notifications = [];
  child.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString());
      assert.ok(match, buffer.toString());
      const length = Number(match[1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      if (message.id !== undefined) {
        const pending = requests.get(message.id);
        requests.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else notifications.push(message);
    }
  });
  function send(method, params, request = false) {
    const message = { jsonrpc: '2.0', method, params };
    let promise;
    if (request) {
      message.id = ++id;
      promise = new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); });
    }
    const data = JSON.stringify(message);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
    return promise;
  }
  async function request(method, params) {
    let timer;
    try { return await Promise.race([send(method, params, true), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`LSP timeout: ${method}\n${stderr}`)), 10_000);
    })]); } finally { clearTimeout(timer); }
  }
  const rootUri = pathToFileURL(process.cwd()).href;
  const initialized = await request('initialize', { processId: process.pid, rootUri, capabilities: {} });
  assert.equal(initialized.serverInfo.name, 'JevaScript');
  send('initialized', {});
  const uri = pathToFileURL(path.resolve('test/editor-fixture.jeva')).href;
  const source = 'const customer = { name: "Ada" };\nconst title = customer.name;\ndecide ("Ready?", { title }) { console.log(title); }\n';
  send('textDocument/didOpen', { textDocument: { uri, languageId: 'jevascript', version: 1, text: source } });
  const context = (line, character) => ({ textDocument: { uri }, position: { line, character } });
  const hover = await request('textDocument/hover', context(1, 7));
  assert.match(hover.contents.value, /title.*string/);
  const definitions = await request('textDocument/definition', context(1, 16));
  assert.equal(definitions[0].range.start.line, 0);
  const completions = await request('textDocument/completion', context(1, 23));
  assert.ok(completions.some(item => item.label === 'name'));
  const references = await request('textDocument/references', { ...context(1, 7), context: { includeDeclaration: true } });
  assert.ok(references.length >= 3);
  const rename = await request('textDocument/rename', { ...context(1, 7), newName: 'subject' });
  assert.ok(rename.changes[uri].length >= 3);
  const symbols = await request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.ok(symbols.some(symbol => symbol.name === 'customer'));
  // Query generic call targets themselves, not only their result variables.
  // Lowering also replaces the enclosing identity call, so it must retain types.
  const decisionUri = pathToFileURL(path.resolve('test/decision-fixture.jeva')).href;
  const decisionSource = `function identity<T>(value: T): T { return value; }
const team = identity(decide.route("Team?", { criteria: ["billing", "technical"], state: {} }));
const assessment = decide.batch({}, { approved: { type: "noul", instructions: "Approved?" } });
`;
  send('textDocument/didOpen', { textDocument: { uri: decisionUri, languageId: 'jevascript', version: 1, text: decisionSource } });
  const decisionContext = offset => {
    const lines = decisionSource.slice(0, offset).split('\n');
    return { textDocument: { uri: decisionUri }, position: { line: lines.length - 1, character: lines.at(-1).length } };
  };
  for (const [target, expected] of [['route', /Promise<"billing" \| "technical">/], ['batch', /approved/], ['identity(decide', /"billing" \| "technical"/]]) {
    const start = decisionSource.indexOf(target);
    const params = decisionContext(start + 1);
    const info = await request('textDocument/hover', params);
    assert.ok(info, `Missing hover for ${target}: ${JSON.stringify(notifications)}`);
    assert.match(info.contents.value, expected);
    const definitions = await request('textDocument/definition', params);
    assert.ok(definitions?.length, `Missing definition for ${target}`);
    assert.ok(definitions.some(definition => definition.uri.endsWith(target === 'identity(decide' ? '/decision-fixture.jeva' : '/runtime/globals.d.ts')));
    const signature = await request('textDocument/signatureHelp', decisionContext(decisionSource.indexOf('(', start) + 1));
    assert.ok(signature?.signatures.length, `Missing signature for ${target}`);
    assert.match(signature.signatures[signature.activeSignature].label, expected);
  }
  const bad = 'const result: number = "wrong";\n';
  send('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: bad }] });
  const deadline = Date.now() + 5000;
  let diagnostic;
  while (Date.now() < deadline) {
    diagnostic = notifications.find(n => n.method === 'textDocument/publishDiagnostics' && n.params.version === 2);
    if (diagnostic) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(diagnostic, stderr + JSON.stringify(notifications));
  assert.equal(diagnostic.params.diagnostics[0].code, 2322);
  assert.equal(diagnostic.params.diagnostics[0].range.start.line, 0);
  // The editor walks lowered trees, including synthetic threshold and chain nodes.
  for (const example of fs.readdirSync('examples').filter(name => name.endsWith('.jeva'))) {
    const exampleUri = pathToFileURL(path.resolve('examples', example)).href;
    const content = fs.readFileSync(path.resolve('examples', example), 'utf8');
    send('textDocument/didOpen', { textDocument: { uri: exampleUri, languageId: 'jevascript', version: 1, text: content } });
    await request('textDocument/documentSymbol', { textDocument: { uri: exampleUri } });
    for (const match of content.matchAll(/\b(?:invoice|transcript|ticket|assessment|state|request|threshold|decide|route|score|batch|probability|assert)\b/g)) {
      const before = content.slice(0, match.index).split('\n');
      const position = { line: before.length - 1, character: before.at(-1).length };
      const params = { textDocument: { uri: exampleUri }, position };
      await request('textDocument/hover', params);
      await request('textDocument/references', { ...params, context: { includeDeclaration: true } });
    }
  }
  assert.ok(!notifications.some(n => n.method === 'window/logMessage' && n.params.type === 1), JSON.stringify(notifications));
  await request('shutdown', null);
  send('exit', null);
});
