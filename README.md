# JevaScript

JevaScript adds decisions to TypeScript. Ask a question about program state,
choose among named actions, or score a situation against a rubric. Ordinary
code controls what happens next.

```typescript
const ticket = { message: "Every API request times out after today's deployment." };

decide.route("What should we inspect first?", {
  criteria: {
    billing: "payments, invoices, and subscription changes",
    diagnostics: "technical failures, outages, and service health",
    human: "requests that need a person's judgment or authority",
  },
  state: ticket,
}) {
  case "billing": console.log("Open billing history"); break;
  case "diagnostics": console.log("Open service health"); break;
  case "human": console.log("Prepare a handoff"); break;
}
```

Save this as `ticket.jeva` and run `jeva run ticket.jeva`.
The application has no model import, client initialization, or inference server
setup. The first decision starts Zevri locally. Later decisions reuse it.

This is a working local v0.1 dialect for Node.js 22 or newer. It uses the Zevri
checkout and checkpoint already on this machine. Editing and compilation do
not load the model.

## Run

```sh
cd ~/Projects/JevaScript
npm ci
npm run build
npm link --ignore-scripts
jeva run examples/agent-tools.jeva
jeva run examples/triage.jeva --trace
```

The current checkout is already installed and built. Rebuilding is only needed
after changing compiler or runtime sources.

The default backend is `../zevri/.venv/bin/python` with the checkpoint
at `../zevri/work/zevri-0.3.0`. Keep that checkout next to JevaScript.
For another location, set `JEVA_ZEVRI_DIR`; `JEVA_PYTHON` and `JEVA_MODEL` can
override its Python executable and checkpoint directory. Model weights are not
included in this repository or downloaded automatically.

```sh
jeva check examples/triage.jeva    # syntax and types, no inference
jeva build examples/triage.jeva    # JavaScript and source maps in .jeva/build
jeva run examples/benchmark.jeva  # cold latency, warm median, and warm p95
npm test                         # compiler, runtime, and LSP regression checks
npm run test:live                 # contracts against the real local model
npm run test:model                # assert four travel routes and four branches
```

Run these commands from your application's root directory. Relative imports
between `.jeva` files work, as do imports of ordinary `.ts` modules and Node
packages. Build output currently refers to this JevaScript checkout's runtime;
keep it available when executing the generated JavaScript.

## Decisions

```typescript
const note = { text: "All items arrived. The delay was caused by our address change." };

decide ("Was the order satisfactorily received?", note).threshold(0.85) {
  console.log("Evidence supports routine processing");
} else {
  console.log("Ask the owner to review");
}

const probability = decide.probability("Was the order satisfactorily received?", note);
const severity = decide.score("How serious is the delivery problem?", {
  criteria: ["no problem", "minor inconvenience", "unusable order"],
  state: note,
});
```

`decide` compares the model's estimated probability of true with a threshold,
which defaults to `0.5`. `threshold(0.85)` requires at least `0.85`. The `else`
branch includes uncertainty below that threshold. An inference error throws;
it never silently becomes `false`.

`decide.route` returns one of the declared labels. TypeScript checks the labels
in its case clauses. `decide.score` returns the expected rubric position
normalized to the range 0 to 1. The rubric must be ordered from low to high.
`decide.probability` returns the raw estimate. `decide.assert` throws if its
threshold is not met.

```typescript
decide ("Is this email urgent?", { email: "Please fix my duplicate charge today." })
  .and("Is this email requesting a refund?", { email: "Please fix my duplicate charge today." })
  .threshold(0.85) {
    console.log("Prepare a priority refund review");
  }
```

`.and` short-circuits. It evaluates the second question and its state only if
the first passes. A final `.threshold` applies to all predicates in the chain;
the last threshold wins. Shared chain thresholds must be numeric literals in
v0.1. Standalone decisions accept a dynamic threshold. The compiler rejects
chaining `.and` onto a route, score, or assertion.

Use `decide.batch(state, questions)` when several independent questions share
the same state. It makes one inference request and preserves each answer's
type. Batch scores use their original rubric scale, and answers include raw
probabilities. See `examples/incident-desk.jeva`.

## Async boundaries

The compiler inserts `await` at decision calls, so a route has its label type
and a score has type `number` at the call site. Decisions are valid at module
top level or inside an `async` function. Function callers still use `await`.
There is no implicit conversion of a synchronous function into an async one.

```typescript
async function handleInput(text: string) {
  decide ("Is this asking to cancel a subscription?", { text }) {
    return "Start the cancellation flow";
  }
  return "Continue normal parsing";
}

console.log(await handleInput("Please stop renewing my plan."));
```

`while`, `&&`, `||`, early returns, and exceptions keep their ordinary JavaScript
behavior. Put a bound on retry loops, as in `examples/support-coach.jeva`.
`decide` is reserved in `.jeva` files; use it directly instead of aliasing it.
State must be a JSON object or a string. Convert dates and class instances
before passing them, and omit undefined fields.

## Examples

| File | Decision |
| --- | --- |
| `examples/travel-router.jeva` | Batch a 15-way route and boolean branch, with explicit review |
| `examples/agent-tools.jeva` | Pick a useful tool from the customer's intent |
| `examples/invoice-exceptions.jeva` | Combine exact accounting limits with judgments about evidence |
| `examples/incident-desk.jeva` | Assess several aspects of an incident in one request |
| `examples/support-coach.jeva` | Decide whether another explanation is needed, within a retry budget |
| `examples/triage.jeva` | Gate, route, and score a support ticket |
| `examples/live.jeva` | Exercise every decision type against Zevri |
| `examples/benchmark.jeva` | Measure startup separately from repeated warm inference |

The examples print recommendations and use local tool fixtures. Their results
come from the model. `reports/verification.md` records observed outcomes,
including uncertain and questionable answers.

## Editors

The CLI and LSP use the same compiler. Both report positions in the original
`.jeva` file. The LSP provides diagnostics, completion, hover, signature help,
definitions, references, rename, and document symbols over stdio.

VS Code's local extension is packaged at `artifacts/jevascript-0.1.0.vsix`.
Install it with:

```sh
code --install-extension artifacts/jevascript-0.1.0.vsix --force
```

Open this folder and a `.jeva` file. The command palette has **JevaScript: Run
current file** and **JevaScript: Restart language server**. The extension uses
the checkout where it was packaged. After moving the checkout, rebuild the
package or set `jevascript.serverPath` to its absolute `src/lsp.mjs` path.

For Zed, run **zed: install dev extension** in the command palette and select
`editors/zed`. Open a `.jeva` file. The extension supplies a Tree-sitter grammar
and starts the same LSP. Its local grammar repository lives in `.jeva/grammar-repo`;
do not delete that directory while using the dev extension.

To regenerate both editor packages:

```sh
rustup target add wasm32-wasip2
npm run editors:package
```

Other editors can start `jeva-lsp --stdio` with language id `jevascript` and
file extension `.jeva`. Formatting, code actions, and automatic imports are not
implemented in v0.1. Compiler settings currently use strict TypeScript with
ES2022 and Node ESM; this version does not read application `tsconfig.json`.

## Compiler and runtime

JevaScript owns a pinned copy of TypeScript 5.9.3 source under
`vendor/typescript`. Its parser recognizes decision blocks, then lowers them
to ordinary awaited TypeScript expressions before binding and checking.
The language service also retains modifier tokens for navigation. See
`vendor/typescript/UPSTREAM.md` for the exact upstream revision and changed files.

`npm run build` bundles these source files. It does not patch generated
TypeScript JavaScript with string replacements. The npm `typescript` package
provides standard library declarations and the bootstrap compiler. Replacing
TypeScript with a newer release requires reviewing the source changes and
running the regression checks.

Generated applications use a small JavaScript runtime and a persistent Python
Zevri process. The worker listens only on loopback, uses a random per-process
token, validates requests and responses, and exits with the application.
One worker serves each application process. Requests are serial; batching is
available for multiple questions about one input. Model startup happens once
per process, rather than once per decision.

The September 18 local benchmark measured a warm median of about 30 ms and p95
of 34 ms over 20 repeated single-question requests. The cold request took
9.2 seconds. These numbers include local transport and inference, use one
request shape, and do not establish accuracy or general workload latency.
Changing input lengths and question sets can incur additional warmup cost.

The language supports the shape of a human judgment: interpreting context,
selecting an action, or estimating severity. Its probabilities are model
outputs, not calibrated guarantees. The current checkpoint needs evaluation
on each intended workload before its decisions can be trusted.

## Evaluated model release

The local default is Zevri 0.3.0. On 900 human-labeled CLINC150 travel/workplace
requests excluded from this adaptation's training and development, complete
route-and-branch accuracy was 84.0%, versus Laya's 80.4%. This is routing among
15 intents within a known domain, not evidence of general-purpose superiority.

The release passed a separate, predeclared review policy. At a 0.90 maximum-option
probability cutoff, Zevri made 20 wrong automatic routes among 713 automatic routes
and deferred 187 requests. Laya made 71 wrong automatic routes among 888 automatic
routes and deferred 12. The tradeoff reduces assumed handling cost when a wrong
route costs ten review units and review costs one. The original target of a
five-point routing-accuracy gain was not met. Jev has no matched result here.

`examples/travel-router.jeva` applies that review rule explicitly using
`decide.batch`. Ordinary `decide.route` returns a declared label; applications
choose their own review behavior. The cutoff is not a safety guarantee.

All 1,260 exported requests were replayed through this launcher and HTTP worker,
including 360 seen-domain controls. The default MPS precision preserved the
release checks and held-out review counts. Reproduce that deployment check with
`scripts/evaluate-model.mjs`; see the model repository's
[protocol and results](https://github.com/PSPDFKit-labs/zevri/tree/main/reports/workflow-v1).
