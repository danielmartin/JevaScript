import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
export const ts = require('../compiler/typescript.cjs');
export const home = fileURLToPath(new URL('../', import.meta.url));
export const virtual = name => name.endsWith('.jeva') ? name + '.ts' : name;
export const actual = name => name.endsWith('.jeva.ts') ? name.slice(0, -3) : name;
const globals = path.join(home, 'runtime/globals.d.ts');
const lib = require.resolve('typescript/lib/lib.es2022.full.d.ts');

export function createProject(rootNames = [], cwd = process.cwd()) {
  const documents = new Map();
  const roots = new Set(rootNames.map(name => virtual(path.resolve(name))));
  let version = 0;
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force, strict: true, skipLibCheck: true,
    allowImportingTsExtensions: true, noEmit: true, sourceMap: true, inlineSources: true,
    types: ['node'], typeRoots: [path.join(cwd, 'node_modules/@types'), path.join(home, 'node_modules/@types')],
  };
  const readFile = name => documents.get(virtual(name))?.text ?? ts.sys.readFile(actual(name));
  const fileExists = name => documents.has(virtual(name)) || ts.sys.fileExists(actual(name));
  const host = {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => cwd,
    getDefaultLibFileName: () => lib,
    getScriptFileNames: () => [...roots, globals],
    getScriptVersion: name => String(documents.get(name)?.version ?? ts.sys.getModifiedTime?.(actual(name))?.getTime() ?? 0),
    getScriptSnapshot: name => { const text = readFile(name); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getScriptKind: name => name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    getProjectVersion: () => String(version),
    fileExists, readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories, realpath: name => virtual(ts.sys.realpath(actual(name))),
    resolveModuleNames(names, containingFile) {
      return names.map(name => {
        if (name.startsWith('.') && name.endsWith('.jeva')) {
          const resolvedFileName = virtual(path.resolve(path.dirname(containingFile), name));
          if (fileExists(resolvedFileName)) return { resolvedFileName, extension: ts.Extension.Ts };
        }
        return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
      });
    },
  };
  const service = ts.createLanguageService(host);
  return {
    service, host, options, cwd,
    update(name, text) { const key = virtual(path.resolve(name)); roots.add(key); documents.set(key, { text, version: ++version }); },
    close(name) { documents.delete(virtual(path.resolve(name))); version++; },
    diagnostics() {
      const program = service.getProgram();
      return program.getSourceFiles().filter(file => !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file))
        .flatMap(file => [...service.getSyntacticDiagnostics(file.fileName), ...service.getSemanticDiagnostics(file.fileName)]);
    },
    build(outDir = path.join(cwd, '.jeva/build')) {
      const errors = this.diagnostics();
      if (errors.some(error => error.category === ts.DiagnosticCategory.Error)) return { diagnostics: errors };
      const program = service.getProgram();
      const emitOptions = program.getCompilerOptions();
      // Emit the same checked program. Import suffix rewriting is an emit-only operation.
      const previous = { ...emitOptions };
      Object.assign(emitOptions, { noEmit: false, allowImportingTsExtensions: false, outDir, rootDir: cwd });
      const outputs = new Map();
      const transformer = context => source => {
        const visit = node => {
          // Lowered chain thresholds occupy no source text. Emit their stored
          // literal value rather than asking the printer to copy an empty span.
          if (ts.isNumericLiteral(node) && node.pos === node.end) return context.factory.createNumericLiteral(node.text);
          if (ts.isStringLiteral(node) && ((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) ||
              (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword))) {
            const next = node.text.endsWith('.jeva') ? node.text + '.js' : node.text.replace(/\.tsx?$/, '.js');
            if (next !== node.text) return context.factory.createStringLiteral(next);
          }
          return ts.visitEachChild(node, visit, context);
        };
        let result = ts.visitNode(source, visit);
        if (source.fileName.endsWith('.jeva.ts')) {
          const runtimeImport = context.factory.createImportDeclaration(undefined,
            context.factory.createImportClause(false, undefined, context.factory.createNamedImports([
              context.factory.createImportSpecifier(false, undefined, context.factory.createIdentifier('decide')),
            ])), context.factory.createStringLiteral(pathToFileURL(path.join(home, 'runtime/runtime.mjs')).href));
          result = context.factory.updateSourceFile(result, [runtimeImport, ...result.statements]);
        }
        return result;
      };
      let emitted;
      try {
        emitted = program.emit(undefined, (name, text, _bom, _error, sources) => {
          if (name.endsWith('.map')) {
            const map = JSON.parse(text);
            map.sources = map.sources.map(source => actual(source));
            text = JSON.stringify(map);
          }
          fs.mkdirSync(path.dirname(name), { recursive: true });
          fs.writeFileSync(name, text);
          for (const source of sources ?? []) if (name.endsWith('.js')) outputs.set(actual(source.fileName), name);
        }, undefined, false, { before: [transformer] });
      } finally { Object.assign(emitOptions, previous); }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'package.json'), '{"type":"module"}\n');
      return { diagnostics: [...errors, ...emitted.diagnostics], outputs };
    },
    dispose() { service.dispose(); },
  };
}

export function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics.map(diagnostic => diagnostic.file ? {
    ...diagnostic, file: Object.assign(Object.create(diagnostic.file), { fileName: actual(diagnostic.file.fileName) }),
  } : diagnostic), { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: x => x, getNewLine: () => '\n' });
}
