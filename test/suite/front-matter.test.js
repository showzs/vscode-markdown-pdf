'use strict';

const assert = require('assert');
const extension = require('../../extension');

suite('Front Matter Test Suite', () => {
    test('renders emoji shortcodes as embedded images', function() {
        this.timeout(10000);
        const html = extension.convertMarkdownToHtml(__filename, 'html', ':smile:');

        assert.match(html, /<img class="emoji" alt="smile" src="data:image\/png;base64,[A-Za-z0-9+/=]+" \/>/);
    });

    test('renders inline and display math with KaTeX', function() {
        this.timeout(10000);
        const html = extension.convertMarkdownToHtml(
            __filename,
            'html',
            'Inline: $\\sqrt{3x-1}+(1+x)^2$\n\n$$\n\\frac{a}{b}\n$$'
        );

        assert.match(html, /<span class="katex">/);
        assert.match(html, /class="katex-display"/);
        assert.doesNotMatch(html, /class="katex-error"/);
    });

    test('embeds KaTeX styles only when the document contains math', function() {
        this.timeout(10000);
        const vscode = require('vscode');
        const uri = vscode.Uri.file(__filename);
        const withMath = extension.makeHtml(extension.convertMarkdownToHtml(__filename, 'html', '$x^2$'), uri);
        const withoutMath = extension.makeHtml(extension.convertMarkdownToHtml(__filename, 'html', 'plain text'), uri);

        assert.match(withMath, /data:font\/woff2;base64,/);
        assert.doesNotMatch(withoutMath, /KaTeX_|data:font\//);
    });

    test('extracts YAML front matter and Markdown content', () => {
        const result = extension.parseFrontMatter('---\r\nbreaks: true\r\n---\r\n# Heading\r\n');

        assert.deepStrictEqual(result.data, { breaks: true });
        assert.strictEqual(result.content, '# Heading\r\n');
    });

    test('keeps documents without a complete front matter block unchanged', () => {
        const text = '---\ntitle: incomplete\n# Heading\n';
        const result = extension.parseFrontMatter(text);

        assert.deepStrictEqual(result.data, {});
        assert.strictEqual(result.content, text);
    });

    test('parses documents without front matter as Markdown', () => {
        const text = '# Heading\n';
        const result = extension.parseFrontMatter(text);

        assert.deepStrictEqual(result.data, {});
        assert.strictEqual(result.content, text);
    });
});
