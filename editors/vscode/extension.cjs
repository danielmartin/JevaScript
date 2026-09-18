const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
let client;
async function activate(context) {
  const configured = vscode.workspace.getConfiguration('jevascript').get('serverPath');
  const local = path.join(context.extensionPath, 'local-server.json');
  const server = configured || (fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8')).path : undefined);
  if (!server || !fs.existsSync(server)) {
    vscode.window.showErrorMessage('Build JevaScript and set jevascript.serverPath to its src/lsp.mjs.');
    return;
  }
  client = new LanguageClient('jevascript', 'JevaScript', { module: server, transport: TransportKind.stdio }, {
    documentSelector: [{ scheme: 'file', language: 'jevascript' }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{jeva,ts,tsx}') },
  });
  context.subscriptions.push(vscode.commands.registerCommand('jevascript.restart', () => client.restart()));
  context.subscriptions.push(vscode.commands.registerCommand('jevascript.run', async () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'jevascript') return;
    await doc.save();
    const root = path.dirname(path.dirname(server));
    const terminal = vscode.window.createTerminal({ name: 'JevaScript', cwd: vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(doc.uri.fsPath),
      shellPath: 'node', shellArgs: ['--enable-source-maps', path.join(root, 'src/cli.mjs'), 'run', doc.uri.fsPath] });
    terminal.show();
  }));
  await client.start();
}
module.exports = { activate, deactivate: () => client?.stop() };
