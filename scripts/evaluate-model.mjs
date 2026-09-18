// Replay exported requests through the actual JevaScript launcher and HTTP worker.
import fs from 'node:fs';
import { decide, stopRuntime } from '../runtime/runtime.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/evaluate-model.mjs requests.jsonl output.jsonl');
const requests = fs.readFileSync(input, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const fd = fs.openSync(output, 'wx');
try {
  for (const [index, request] of requests.entries()) {
    const started = performance.now();
    const answers = await decide.batch(request.state, request.questions);
    fs.writeSync(fd, JSON.stringify({ id: request.id, request_sha256: request.request_sha256,
      response: { answers }, ms: performance.now() - started }) + '\n');
    if ((index + 1) % 100 === 0) console.log(`JevaScript replay ${index + 1}/${requests.length}`);
  }
} finally {
  fs.closeSync(fd);
  stopRuntime();
}
