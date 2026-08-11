'use strict';

const assert = require('assert');
const extension = require('../../extension');

suite('Front Matter Test Suite', () => {
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
