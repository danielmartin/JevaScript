#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProject, formatDiagnostics } from './project.mjs';
const [command, entry, ...flags] = process.argv.slice(2);
process.setSourceMapsEnabled(true);
if (!['run', 'check', 'build'].includes(command) || !entry) {
  console.log('JevaScript\n\n  jeva run <file.jeva> [--trace] [--record file.jsonl | --replay file.jsonl]\n  jeva check <file.jeva>\n  jeva build <file.jeva>\n  jeva-lsp --stdio');
  process.exit(command === '--help' || !command ? 0 : 1);
}
try {
  if (!fs.existsSync(entry)) throw new Error(`File not found: ${entry}`);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--trace') process.env.JEVA_TRACE = '1';
    else if (command === 'run' && (flag === '--record' || flag === '--replay')) {
      const filename = flags[++i];
      if (!filename || filename.startsWith('--')) throw new Error(`${flag} requires a filename`);
      process.env[flag === '--record' ? 'JEVA_RECORD' : 'JEVA_REPLAY'] = path.resolve(filename);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (process.env.JEVA_RECORD && process.env.JEVA_REPLAY) throw new Error('Choose --record or --replay, not both');
  if (command === 'run' && process.env.JEVA_REPLAY) {
    console.error(`[JevaScript] Replay mode: ${process.env.JEVA_REPLAY} (no inference)`);
  }
  const project = createProject([entry]);
  const result = command === 'check' ? { diagnostics: project.diagnostics() } : project.build();
  if (result.diagnostics.length) {
    process.stderr.write(formatDiagnostics(result.diagnostics));
    process.exitCode = 1;
  } else if (command === 'run') {
    const emitted = result.outputs.get(path.resolve(entry));
    if (!emitted) throw new Error('Compiler did not emit the entry file');
    await import(pathToFileURL(emitted).href);
    const { finishReplay } = await import('../runtime/runtime.mjs');
    await finishReplay();
  } else console.log(command === 'check' ? 'No errors' : 'Built .jeva/build');
  project.dispose();
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
