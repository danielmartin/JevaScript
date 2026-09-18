# Local verification

Verified September 18, 2026 on this Apple Silicon Mac, using the existing
Vela checkpoint at `../vela-decision/work/candidate`.

`npm test` passes six regression checks. It builds and type-checks the actual
TypeScript source fork, exercises runtime validation and transport failures,
executes compiled control flow against a deterministic fixture, and exchanges
real LSP messages over stdio. The LSP check covers hover and references across
every example, as well as diagnostics, completion, definitions, rename, and
document symbols.

The execution check verifies that a failed first predicate skips the second
predicate's state expression, a shared threshold applies to both predicates,
the last threshold wins, loops respect their bound, routes select case clauses,
and inference failures propagate as exceptions.

All seven `.jeva` examples pass type checking and the Tree-sitter editor
parser. All six non-benchmark examples ran against Vela with the final
compiler. The live contract check exercises boolean, choice, score,
probability, assertion, and batch answers.

## Measured latency

The benchmark runs one cold request, three warmup requests, then 20 timed
requests with the same question and state. It includes inference and local
HTTP transport. It does not cache answers in JavaScript.

| Measurement | Time |
| --- | ---: |
| Cold first decision, including model startup | 9,216.7 ms |
| Warm median | 29.9 ms |
| Warm p95 | 33.7 ms |

See `benchmark.json` for the machine-readable result. In the separate run of
all examples, model startup took 8.8 seconds. Early requests and different
question shapes had higher latency. These measurements cover one local
checkpoint and do not establish general workload performance.

## Observed decisions

- Tool routing selected billing for a disputed seat charge, diagnostics for
  API timeouts, and a human for contract negotiation.
- Incident assessment selected investigate with probability 0.6228, so the
  example requested review. Its customer-impact probability was only 0.4222
  despite explicit failed purchases. This is a model-quality failure case.
- The invoice example sent both in-budget cases to review at threshold 0.85.
  The over-budget invoice took the exact accounting guard without inference.
- The support loop ran one explanation, then judged the conversation resolved
  even though the customer asked which dates each invoice covered. This is
  another questionable judgment that needs workload evaluation.
- Support triage routed the duplicate-charge request to billing. Its refund
  probability did not clear 0.85, so the branch requested a closer look.

These are raw observed outcomes, not an accuracy benchmark. The examples
demonstrate language behavior without pretending every model answer is right.

## Editors

The VS Code VSIX builds and installs locally. VS Code opened the project,
recognized `agent-tools.jeva`, and displayed its inferred tool types in a hover.
The Zed Rust extension builds
for `wasm32-wasip2`, and Zed installed it as a development extension, compiled
the grammar, recognized `agent-tools.jeva`, and displayed typed hover results
from the JevaScript LSP. The editor never starts Vela.

The integrations use the checkout's absolute server path. Repackage them if
the checkout moves. This is a local development distribution, not a published
editor-marketplace release.
