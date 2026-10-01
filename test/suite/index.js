'use strict';

const path = require('path');
const Mocha = require('mocha');
const { glob } = require('glob');

module.exports = {
    run: async function() {
        // Create the mocha test
        const mocha = new Mocha({
            ui: 'tdd',
            color: true
        });

        const testsRoot = path.resolve(__dirname, '..');
        const files = await glob('**/*.test.js', { cwd: testsRoot });
        files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

        return new Promise((c, e) => {
            try {
                // Run the mocha test
                mocha.run(failures => {
                if (failures > 0) {
                    e(new Error(`${failures} tests failed.`));
                } else {
                    c();
                }
                });
            } catch (err) {
                e(err);
            }
        });
    }
}
