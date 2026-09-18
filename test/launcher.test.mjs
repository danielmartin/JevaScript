import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('installed command targets are executable without a node wrapper', { skip: process.platform === 'win32' }, () => {
  for (const entry of ['src/cli.mjs', 'src/lsp.mjs']) {
    fs.accessSync(entry, fs.constants.X_OK);
  }
  const result = spawnSync(path.resolve('src/cli.mjs'), ['--help'], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /jeva run/);
});
