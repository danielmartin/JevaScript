# Follow a decision from input to action

Start with `decision-audit.jeva`. It handles travel-support requests using
ordinary TypeScript permissions and a model's interpretation of the request.
It prepares local handoffs; it does not purchase or book anything.

## 1. Run the included recording

From the repository root, after `npm ci` and `npm run build`:

```sh
npm run demo
```

No Python environment or model is needed. These are real outputs captured
from the local Refli 0.1.0 checkpoint on September 18, 2026, not scripted answers:

| Input | Recorded estimate | Application action at 0.90 |
| --- | --- | --- |
| Book a flight to Madrid | `book flight`: 0.9706 | Prepare a flight handoff |
| Status of flight BA249 | `flight status`: 0.9706 | Prepare a status lookup |
| Book a flight and a hotel | `book flight`: 0.8633 | Human review |
| Something went wrong with my trip | `travel notification`: 0.9441 | Prepare a handoff, despite inadequate detail |
| Flight request without account permission | No inference | Require sign-in |

The fourth row is deliberately retained. A high model estimate can still
produce an unjustified route. The example prints an author review note for it;
that note is a human annotation, not a second model judgment or automatic fix.

Open [the source](decision-audit.jeva) beside
[the recording](recordings/decision-audit.jsonl). Each recording entry contains
the exact model input, named questions, allowed options, complete distributions,
answers, checkpoint path label, and inference-request duration. The source
shows the threshold and branch. This explains how the application chose an
action, not the model's internal reasoning. The model label is informational,
not a cryptographic identity; the included files omit the machine's absolute path.

## 2. Change the policy without changing the answers

```sh
TRAVEL_REVIEW_THRESHOLD=0.95 npm run demo
```

The vague trip request now goes to review. The flight and status requests
still pass. No model reruns, so a changed branch comes from the policy change.
This is a demonstration of mechanics, not evidence that 0.95 is the right
production threshold. Choosing a cutoff requires labeled workload evaluation.

Replay validates the current inputs, questions, option order, and request
sequence against the recording. Change the question or a customer's text and
the run fails with `Replay mismatch`. It also rejects missing or invalid recorded answers, and fails when the
program leaves entries unused.
It never silently substitutes live inference. Review policies are application
code, so intentionally changing a threshold is allowed.

## 3. Run your local model and record new decisions

With Refli installed as described in the root README:

```sh
npm run demo:live
node src/cli.mjs run examples/decision-audit.jeva --record .jeva/my-travel.jsonl --trace
node src/cli.mjs run examples/decision-audit.jeva --replay .jeva/my-travel.jsonl
```

Recording refuses to overwrite an existing file. Choose a new filename for
each run. Files contain full input text and are created with owner-only
permissions; `.jeva/` is ignored by Git. `--trace` prints runtime results and
latency; the recording holds the question and state needed to interpret them.
Startup is separate from each entry's request duration.

Recording and replay currently support sequential decisions and batches,
not overlapping calls. Only successful validated inference responses are
recorded. Inference errors still throw. Replay reruns application code,
including its side effects; these examples use only console output.
This is a decision recording, not a snapshot of the whole process.

## 4. Catch a model regression

`decision-regression.jeva` contains two human-labeled cases from the original
checkout and support-loop failures. It prints the probability, threshold,
expected answer, and actual answer. A disagreement exits with status 1.

```sh
# Inspect the included run without loading a model.
node src/cli.mjs run examples/decision-regression.jeva --replay examples/recordings/decision-regression.jsonl

# Evaluate your current checkpoint.
node src/cli.mjs run examples/decision-regression.jeva --record .jeva/regression-current.jsonl

# Evaluate a candidate on the same cases, then compare the printed results.
JEVA_MODEL=/absolute/path/to/candidate node src/cli.mjs run examples/decision-regression.jeva --record .jeva/regression-candidate.jsonl
```

The included run passes both cases: checkout impact is 0.9551 and continuing
confusion is 0.9813. These are individual probability requests; the historical
incident example evaluated impact alongside two other questions in a batch.
They are useful regression cases, not a controlled replication of that batch
or proof of general accuracy. The original examples remain available unchanged.

## 5. See what the language and TypeScript each contribute

```sh
node src/cli.mjs check examples/decision-audit.jeva
```

In VS Code or Zed with the JevaScript extension, hover over
`answers.route.choice`: its type is the union of the 15 allowed tools.
Follow `reviewRoute` into [travel-policy.ts](travel-policy.ts). It returns an
ordinary discriminated union. Inside the `accepted` branch, `result.tool` is
available. Add `console.log(result.tool)` at the marked position after the
switch and the editor and CLI report a type error. Remove it to restore the demo.

The `.jeva` compiler waits for `decide.batch` and preserves its answer types.
The `.ts` module handles policy using normal TypeScript rules. The runtime
starts and reuses the local model, or supplies checked recorded answers.
This keeps model plumbing out of the workflow while leaving rules visible.

For the custom block syntax, open [agent-tools.jeva](agent-tools.jeva):
`decide.route(...) { case ... }` dispatches among typed labels. An undeclared
case label is a compiler error. That shorter form returns a label; use the
batch form in this walkthrough when the application needs probabilities.

These examples do not implement a new `decision` declaration, compiler-enforced
uncertainty handling, automatic source-linked decision identities, or an editor
trace viewer. The review union is application code, and the recordings are
runtime support. Those distinctions matter when assessing the language's value.
