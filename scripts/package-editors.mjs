import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const server = path.join(root, 'src/lsp.mjs');
const vscode = path.join(root, 'editors/vscode');
const zed = path.join(root, 'editors/zed');
const grammar = path.join(root, 'editors/tree-sitter-jevascript');
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(vscode, 'local-server.json'), JSON.stringify({ path: server }));
fs.writeFileSync(path.join(zed, 'local-server.txt'), server + '\n');
await build({ entryPoints: [path.join(vscode, 'extension.cjs')], outfile: path.join(vscode, 'out/extension.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18', logLevel: 'warning' });
fs.copyFileSync(path.join(root, 'vendor/typescript/LICENSE.txt'), path.join(vscode, 'LICENSE.txt'));
fs.writeFileSync(path.join(vscode, 'README.md'), '# JevaScript\n\nOpen a `.jeva` file for diagnostics, completion, hover, navigation, and rename. Use **JevaScript: Run current file** to execute it.\n\nThis local development package connects to the JevaScript checkout used to build it. Rebuild the VSIX after moving the checkout. It never loads a model for editing.\n');
run(process.execPath, [path.join(root, 'node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies', '--allow-missing-repository',
  '--out', path.join(root, 'artifacts/jevascript-0.1.0.vsix')], vscode);

run(path.join(root, 'node_modules/.bin/tree-sitter'), ['generate'], grammar);
const scanner = fs.readFileSync(path.join(root, 'node_modules/tree-sitter-typescript/typescript/src/scanner.c'), 'utf8')
  .replaceAll('tree_sitter_typescript', 'tree_sitter_jevascript').replace('../../common/scanner.h', 'scanner.h');
fs.writeFileSync(path.join(grammar, 'src/scanner.c'), scanner);
fs.copyFileSync(path.join(root, 'node_modules/tree-sitter-typescript/common/scanner.h'), path.join(grammar, 'src/scanner.h'));
fs.copyFileSync(path.join(root, 'node_modules/tree-sitter-typescript/LICENSE'), path.join(grammar, 'LICENSE'));
const highlights = fs.readFileSync(path.join(root, 'node_modules/tree-sitter-javascript/queries/highlights.scm'), 'utf8') + '\n' +
  fs.readFileSync(path.join(root, 'node_modules/tree-sitter-typescript/queries/highlights.scm'), 'utf8') + '\n"decide" @keyword\n';
fs.writeFileSync(path.join(zed, 'languages/jevascript/highlights.scm'), highlights);

// Zed consumes a Git revision for grammars. Keep the local distribution repository
// in ignored build output; the grammar's actual sources remain in editors/.
const grammarRepo = path.join(root, '.jeva/grammar-repo');
fs.mkdirSync(grammarRepo, { recursive: true });
fs.cpSync(path.join(grammar, 'src'), path.join(grammarRepo, 'src'), { recursive: true });
fs.copyFileSync(path.join(grammar, 'LICENSE'), path.join(grammarRepo, 'LICENSE'));
if (!fs.existsSync(path.join(grammarRepo, '.git'))) run('git', ['init', '-b', 'main'], grammarRepo);
run('git', ['add', 'src', 'LICENSE'], grammarRepo);
run('git', ['-c', 'user.name=JevaScript build', '-c', 'user.email=build@localhost', '-c', 'commit.gpgsign=false',
  'commit', '--allow-empty', '-m', 'Build JevaScript editor grammar'], grammarRepo);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: grammarRepo, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(zed, 'extension.toml'), `id = "jevascript"
name = "JevaScript"
version = "0.1.0"
schema_version = 1
authors = ["JevaScript contributors"]
description = "TypeScript with built-in probabilistic decisions"

[language_servers.jevascript]
name = "JevaScript Language Server"
languages = ["JevaScript"]
language_ids = { JevaScript = "jevascript" }

[grammars.jevascript]
repository = "${pathToFileURL(grammarRepo).href}"
rev = "${revision}"
`);
run('cargo', ['build', '--release', '--target', 'wasm32-wasip2'], zed);
fs.copyFileSync(path.join(zed, 'target/wasm32-wasip2/release/jevascript_zed.wasm'), path.join(zed, 'extension.wasm'));
console.log('VS Code package: artifacts/jevascript-0.1.0.vsix');
console.log('Zed dev extension: editors/zed');
