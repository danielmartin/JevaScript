# TypeScript source fork

This directory contains the TypeScript source snapshot from Microsoft/TypeScript
v5.9.3, commit `c63de15a992d37f0d6cec03ac7631872838602cb`.

JevaScript changes `src/compiler/parser.ts`, adds `src/compiler/jeva.ts`, and
teaches `src/services/services.ts` to preserve lowered modifier tokens for editor
navigation. The binder, checker, emitter, and scanner remain upstream code.
`npm run build` generates diagnostic constants and bundles these sources with
esbuild. It never rewrites compiler JavaScript or modifies node_modules.

The npm TypeScript package supplies standard library declarations and the
bootstrap compiler for our runtime. The JevaScript CLI and LSP both load the
compiler built from this directory.

Microsoft's Apache-2.0 license and third-party notices are included alongside
the sources. The diagnostic generation script under `scripts/` is also copied
from the same revision.
