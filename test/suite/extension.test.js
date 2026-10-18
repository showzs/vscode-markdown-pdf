'use strict';

const before = require('mocha').before;
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = require('vscode');
// const myExtension = require('.extension');

suite('Extension Test Suite', () => {
    before(() => {
        vscode.window.showInformationMessage('Start all tests.');
    });

    test('Mermaid', async function() {
        this.timeout(6000000);
        var textDocument = await vscode.workspace.openTextDocument(path.resolve(__dirname, 'mermaid.md'));
        await vscode.window.showTextDocument(textDocument);
        await vscode.commands.executeCommand('extension.markdown-pdf.all');

        const html = fs.readFileSync(path.resolve(__dirname, 'mermaid.html'), 'utf-8');
        assert.match(html, /class="katex"/);
        assert.match(html, /class="katex-display"/);
        assert.doesNotMatch(html, /class="katex-error"/);
        assert.match(html, /data:font\/woff2;base64,/);

        fs.rmSync(path.resolve(__dirname, 'mermaid.pdf'), { force: true });
        fs.rmSync(path.resolve(__dirname, 'mermaid.jpeg'), { force: true });
        fs.rmSync(path.resolve(__dirname, 'mermaid.png'), { force: true });
        fs.rmSync(path.resolve(__dirname, 'mermaid.html'), { force: true });
    });
});
