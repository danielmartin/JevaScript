import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createJev, JevAssertionError } from "../dist/client.js";

test("HTTP decisions, batching, validation, cancellation, and error branches", async t => {
  let count = 0;
  let lastRequest;
  let mode = "ok";
  let p = 0.85;
  const server = createServer(async (req, res) => {
    count++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastRequest = JSON.parse(Buffer.concat(chunks));
    if (mode === "slow") {
      setTimeout(() => res.end("{}"), 100);
      return;
    }
    if (mode === "error") { res.writeHead(503).end(); return; }
    if (mode === "bad-json") { res.end("not json"); return; }
    const answers = Object.fromEntries(Object.entries(lastRequest.questions).map(([id, q]) => {
      if (q.type === "noul") return [id, { type: "noul", noul: p, confidence: Math.max(p, 1 - p) }];
      const keys = q.type === "score" ? q.criteria.map((_, i) => String(i))
        : Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria);
      const probabilities = Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.1 : i === 1 ? 0.9 : 0]));
      return [id, { type: q.type, choice: keys[1], score: 0.9, confidence: 0.531, probabilities }];
    }));
    if (mode === "missing") { res.end(JSON.stringify({ answers: {} })); return; }
    if (mode === "wrong-choice") answers.result.choice = "unrequested";
    if (mode === "bad-probability") answers.result.noul = 1.1;
    if (mode === "wrong-type") answers.result.type = "score";
    if (mode === "bad-score") answers.result.score = 10;
    if (mode === "bad-distribution") answers.result.probabilities = { a: 0.9, b: 0.9 };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/predict`;
  const jev = createJev({ endpoint, timeoutMs: 1000 });

  assert.equal(await jev("Spam?", { input: "hello" }, { threshold: 0.85 }), true);
  assert.equal(await jev("Spam?", {}, { threshold: 0.86 }), false);
  assert.equal(await jev.probability("Spam?", {}), 0.85);
  assert.deepEqual(lastRequest.questions.result, { type: "noul", instructions: "Spam?" });
  p = 0.05; // High confidence in false must not satisfy a positive threshold.
  assert.equal(await jev("Safe to merge?", {}, { threshold: 0.85 }), false);
  await assert.rejects(jev.assert("Polite?", {}), error => error instanceof JevAssertionError && error.probability === 0.05);
  p = 0.85;
  await jev.assert("Polite?", {}, { threshold: 0.85 });
  assert.equal(await jev.route("Team?", { criteria: ["billing", "technical"], state: {} }), "technical");
  assert.equal(await jev.route("Team?", { criteria: { billing: "payments", technical: "bugs" }, state: {} }), "technical");
  assert.equal(await jev.score("Severity?", { criteria: ["low", "medium", "high"], state: {} }), 0.45);

  const beforeBatch = count;
  const result = await jev.predict("ticket", {
    spam: { type: "noul", instructions: "Spam?" },
    team: { type: "choice", instructions: "Team?", criteria: ["a", "b"] },
    score: { type: "score", instructions: "Severity?", criteria: ["low", "high"] },
  });
  assert.equal(count, beforeBatch + 1);
  assert.equal(result.spam.noul, 0.85);
  assert.equal(result.team.choice, "b");
  assert.equal(result.score.score, 0.9);

  const beforeInvalid = count;
  for (const state of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: new Date() }, 42, null]) {
    await assert.rejects(jev("Question?", state), TypeError);
  }
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(jev("Question?", cyclic), /cycles/);
  await assert.rejects(jev("Question?", {}, { threshold: NaN }), /threshold/);
  await assert.rejects(jev("", {}), /nonempty/);
  for (const criteria of [[], ["a"], ["a", "a"], ["a", ""], [1, 2]]) {
    await assert.rejects(jev.route("Team?", { criteria, state: {} }), TypeError);
  }
  await assert.rejects(jev.predict({}, {}), /questions/);
  await assert.rejects(jev("Question?", "x".repeat(1_048_576)), /1 MiB/);
  assert.equal(count, beforeInvalid);

  for (const failure of ["error", "bad-json", "missing", "wrong-type", "bad-probability"]) {
    mode = failure;
    let action = "untouched";
    await assert.rejects(async () => {
      if (await jev("Fraud?", {})) action = "hold";
      else action = "approve";
    });
    assert.equal(action, "untouched");
  }
  for (const failure of ["wrong-choice", "bad-distribution"]) {
    mode = failure;
    await assert.rejects(jev.route("Team?", { criteria: ["a", "b"], state: {} }), TypeError);
  }
  mode = "bad-score";
  await assert.rejects(jev.score("Severity?", { criteria: ["low", "high"], state: {} }), TypeError);
  mode = "slow";
  await assert.rejects(createJev({ endpoint, timeoutMs: 10 })("Question?", {}), { name: "TimeoutError" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(jev("Question?", {}, { signal: controller.signal }), { name: "AbortError" });
  mode = "ok";
  p = 0.1;
  const beforeChain = count;
  const both = await jev("Urgent?", {}) && await jev("Refund?", {});
  assert.equal(both, false);
  assert.equal(count, beforeChain + 1);
  assert.throws(() => createJev({ timeoutMs: -1 }), /timeoutMs/);
});
