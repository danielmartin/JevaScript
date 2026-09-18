import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = root + 'vendor/typescript';
execFileSync(process.execPath, [root + 'scripts/generate-diagnostics.mjs', source + '/src/compiler/diagnosticMessages.json'], { stdio: 'inherit' });
await build({ entryPoints: [source + '/src/typescript/typescript.ts'], outfile: root + 'compiler/typescript.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true,
  packages: 'external', logLevel: 'warning' });
const ts = require('typescript');
const config = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, strict: true, declaration: true,
  skipLibCheck: true, outDir: root + 'dist', rootDir: root + 'runtime', noEmitOnError: true };
const program = ts.createProgram([root + 'runtime/client.ts'], config);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => root, getCanonicalFileName: x => x, getNewLine: () => '\n',
}));
program.emit();
console.log('Built JevaScript from vendored TypeScript source');
