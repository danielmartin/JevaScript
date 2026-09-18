import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createJev } from '../dist/client.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let starting;
let worker;
const trace = message => { if (process.env.JEVA_TRACE === '1') process.stderr.write(`[JevaScript] ${message}\n`); };

function start() {
  if (starting) return starting;
  if (process.env.JEVA_RECORD && process.env.JEVA_REPLAY) throw new Error('Choose recording or replay, not both');
  if (process.env.JEVA_REPLAY) {
    trace(`Replaying ${process.env.JEVA_REPLAY}; no model loaded`);
    starting = Promise.resolve(createJev({ replayPath: process.env.JEVA_REPLAY }));
    return starting;
  }
  starting = new Promise((resolve, reject) => {
    const refli = process.env.JEVA_REFLI_DIR ?? path.resolve(root, '../refli');
    const python = process.env.JEVA_PYTHON ?? path.join(refli, '.venv/bin/python');
    const model = process.env.JEVA_MODEL ?? path.join(refli, 'work/refli-0.1.0');
    if (!fs.existsSync(python) || !fs.existsSync(path.join(model, 'model.safetensors'))) {
      reject(new Error('Refli is not installed. Keep refli beside JevaScript, or set JEVA_REFLI_DIR / JEVA_PYTHON / JEVA_MODEL.'));
      return;
    }
    const token = randomBytes(24).toString('hex');
    const started = performance.now();
    trace('Starting Refli');
    worker = spawn(python, ['-u', path.join(root, 'runtime/worker.py'), '--port', '0', '--model', model], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: [refli, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', JEVA_WORKER_TOKEN: token },
    });
    const child = worker;
    let buffer = '';
    let stderr = '';
    let ready = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Refli did not become ready within 120 seconds')); }, 120_000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.startsWith('JEVA_READY ')) {
          try {
            const { port } = JSON.parse(line.slice(11));
            if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid Refli worker port');
            ready = true;
            clearTimeout(timer);
            trace(`Refli ready in ${(performance.now() - started).toFixed(0)} ms`);
            // Idle model processes must not keep an otherwise completed program alive.
            child.unref(); child.stdout.unref(); child.stderr.unref();
            resolve(createJev({ endpoint: `http://127.0.0.1:${port}/predict`, token, timeoutMs: 30_000,
              recordPath: process.env.JEVA_RECORD, model }));
          } catch (error) { child.kill(); reject(error); }
        }
      }
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (worker === child) worker = undefined;
      starting = undefined;
      if (!ready) reject(new Error(`Refli startup failed (${signal ?? code}): ${stderr.trim()}`));
      else if (code && process.env.JEVA_TRACE === '1') trace(`Refli exited: ${stderr.trim()}`);
    });
  });
  starting.catch(() => { starting = undefined; });
  return starting;
}

async function invoke(method, args) {
  const client = await start();
  const startTime = performance.now();
  const result = await (method === 'test' ? client(...args) : client[method](...args));
  trace(`${method}: ${JSON.stringify(result)} in ${(performance.now() - startTime).toFixed(1)} ms`);
  return result;
}
export const decide = Object.assign((...args) => invoke('test', args), {
  route: (...args) => invoke('route', args), score: (...args) => invoke('score', args),
  assert: (...args) => invoke('assert', args), probability: (...args) => invoke('probability', args),
  batch: (...args) => invoke('predict', args),
});
export function stopRuntime() { if (worker) { worker.kill(); worker = undefined; } starting = undefined; }
export async function finishReplay() {
  // Also detect an entirely skipped recording when the application made no decisions.
  if (starting || process.env.JEVA_REPLAY) (await start()).finishReplay();
}
process.once('exit', stopRuntime);
