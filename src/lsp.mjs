#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind,
  CompletionItemKind, InsertTextFormat, DiagnosticSeverity, SymbolKind } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createProject, virtual, actual, ts } from './project.mjs';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let project;
let timer;
const fileName = uri => fileURLToPath(uri);
const uriFor = name => pathToFileURL(actual(name)).href;
const safe = handler => async params => {
  try { return await handler(params); }
  catch (error) { connection.console.error(error.stack ?? String(error)); return null; }
};
function documentFor(name) {
  const uri = uriFor(name);
  return documents.get(uri) ?? TextDocument.create(uri, 'jevascript', 0, fs.readFileSync(actual(name), 'utf8'));
}
function range(doc, span) {
  return { start: doc.positionAt(Math.max(0, span.start)), end: doc.positionAt(Math.max(0, span.start + span.length)) };
}
function requestContext(params) {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) throw new Error('Document is not open');
  return { doc, name: virtual(fileName(doc.uri)), position: doc.offsetAt(params.position) };
}
const kinds = {
  method: CompletionItemKind.Method, function: CompletionItemKind.Function, property: CompletionItemKind.Property,
  class: CompletionItemKind.Class, interface: CompletionItemKind.Interface, const: CompletionItemKind.Constant,
  let: CompletionItemKind.Variable, var: CompletionItemKind.Variable, keyword: CompletionItemKind.Keyword,
  module: CompletionItemKind.Module, type: CompletionItemKind.TypeParameter, 'string': CompletionItemKind.Value,
};
connection.onInitialize(params => {
  const root = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  project = createProject([], root ? fileName(root) : process.cwd());
  return { serverInfo: { name: 'JevaScript', version: '0.1.0' }, capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: ['.', '"', "'"], resolveProvider: true },
    hoverProvider: true, definitionProvider: true, referencesProvider: true,
    renameProvider: { prepareProvider: true }, documentSymbolProvider: true,
    signatureHelpProvider: { triggerCharacters: ['(', ','] },
  } };
});

function publish() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      const all = project.diagnostics();
      for (const doc of documents.all()) {
        const name = virtual(fileName(doc.uri));
        connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics: all.filter(d => d.file?.fileName === name).map(d => ({
          range: range(doc, { start: d.start ?? 0, length: d.length ?? 1 }),
          severity: d.category === ts.DiagnosticCategory.Error ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
          code: d.code, source: 'JevaScript', message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        })) });
      }
    } catch (error) { connection.console.error(error.stack ?? String(error)); }
  }, 80);
}
documents.onDidChangeContent(({ document }) => { project.update(fileName(document.uri), document.getText()); publish(); });
documents.onDidClose(({ document }) => { project.close(fileName(document.uri)); connection.sendDiagnostics({ uri: document.uri, diagnostics: [] }); });
connection.onDidChangeWatchedFiles(() => { for (const doc of documents.all()) project.update(fileName(doc.uri), doc.getText()); publish(); });

connection.onCompletion(safe(params => {
  const { doc, name, position } = requestContext(params);
  const prefix = doc.getText().slice(0, position);
  if (/\bdecide\.\w*$/.test(prefix)) return ['route', 'score', 'assert', 'probability', 'batch'].map(label => ({ label, kind: CompletionItemKind.Function }));
  if (/\)\.(?:th\w*|an\w*)?$/.test(prefix)) return ['threshold', 'and'].map(label => ({ label, kind: CompletionItemKind.Method }));
  const entries = project.service.getCompletionsAtPosition(name, position, { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: true })?.entries ?? [];
  const items = entries.map(entry => ({ label: entry.name, kind: kinds[entry.kind] ?? CompletionItemKind.Variable,
    sortText: entry.sortText, insertText: entry.insertText, data: { name, position, entry: entry.name },
    ...(entry.replacementSpan ? { textEdit: { range: range(doc, entry.replacementSpan), newText: entry.insertText ?? entry.name } } : {}),
  }));
  items.push({ label: 'decide block', kind: CompletionItemKind.Snippet, insertTextFormat: InsertTextFormat.Snippet,
    insertText: 'decide ("${1:Question?}", ${2:state}).threshold(${3:0.85}) {\n\t$0\n} else {\n\t\n}', detail: 'Probabilistic conditional' });
  return items;
}));
connection.onCompletionResolve(safe(item => {
  if (!item.data) return item;
  const info = project.service.getCompletionEntryDetails(item.data.name, item.data.position, item.data.entry, {}, undefined, {});
  if (info) { item.detail = ts.displayPartsToString(info.displayParts); item.documentation = { kind: 'markdown', value: ts.displayPartsToString(info.documentation) }; }
  return item;
}));
connection.onHover(safe(params => {
  const { doc, name, position } = requestContext(params);
  const info = project.service.getQuickInfoAtPosition(name, position);
  if (!info) return null;
  return { range: range(doc, info.textSpan), contents: { kind: 'markdown', value:
    '```typescript\n' + ts.displayPartsToString(info.displayParts) + '\n```\n' + ts.displayPartsToString(info.documentation) } };
}));
connection.onDefinition(safe(params => {
  const { name, position } = requestContext(params);
  return (project.service.getDefinitionAtPosition(name, position) ?? []).map(def => ({ uri: uriFor(def.fileName), range: range(documentFor(def.fileName), def.textSpan) }));
}));
connection.onReferences(safe(params => {
  const { name, position } = requestContext(params);
  return (project.service.getReferencesAtPosition(name, position) ?? []).filter(ref => params.context.includeDeclaration || !ref.isDefinition)
    .map(ref => ({ uri: uriFor(ref.fileName), range: range(documentFor(ref.fileName), ref.textSpan) }));
}));
connection.onPrepareRename(safe(params => {
  const { doc, name, position } = requestContext(params);
  const info = project.service.getRenameInfo(name, position, { allowRenameOfImportPath: false });
  if (!info.canRename || info.displayName === 'decide') return null;
  return { range: range(doc, info.triggerSpan), placeholder: info.displayName };
}));
connection.onRenameRequest(safe(params => {
  const { name, position } = requestContext(params);
  const info = project.service.getRenameInfo(name, position, { allowRenameOfImportPath: false });
  if (!info.canRename || info.displayName === 'decide' || params.newName === 'decide') return null;
  const changes = {};
  for (const location of project.service.findRenameLocations(name, position, false, false) ?? []) {
    (changes[uriFor(location.fileName)] ??= []).push({ range: range(documentFor(location.fileName), location.textSpan), newText: params.newName });
  }
  return { changes };
}));
connection.onSignatureHelp(safe(params => {
  const { name, position } = requestContext(params);
  const info = project.service.getSignatureHelpItems(name, position, undefined);
  if (!info) return null;
  return { activeSignature: info.selectedItemIndex, activeParameter: info.argumentIndex,
    signatures: info.items.map(item => ({ label: ts.displayPartsToString(item.prefixDisplayParts) +
      item.parameters.map(p => ts.displayPartsToString(p.displayParts)).join(ts.displayPartsToString(item.separatorDisplayParts)) +
      ts.displayPartsToString(item.suffixDisplayParts), documentation: ts.displayPartsToString(item.documentation),
      parameters: item.parameters.map(p => ({ label: ts.displayPartsToString(p.displayParts), documentation: ts.displayPartsToString(p.documentation) })),
    })) };
}));
connection.onDocumentSymbol(safe(params => {
  const doc = documents.get(params.textDocument.uri);
  const tree = project.service.getNavigationTree(virtual(fileName(doc.uri)));
  const convert = item => ({ name: item.text, kind: ({ function: SymbolKind.Function, class: SymbolKind.Class, interface: SymbolKind.Interface,
    const: SymbolKind.Constant, method: SymbolKind.Method })[item.kind] ?? SymbolKind.Variable,
    range: range(doc, item.spans[0]), selectionRange: range(doc, item.nameSpan ?? item.spans[0]), children: (item.childItems ?? []).map(convert) });
  return (tree.childItems ?? []).map(convert);
}));
connection.onShutdown(() => { clearTimeout(timer); project?.dispose(); });
documents.listen(connection);
connection.listen();
