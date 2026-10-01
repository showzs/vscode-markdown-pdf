#!/usr/bin/env node

var fs = require('fs');
var path = require('path');
var removeNPMAbsolutePaths = require('removeNPMAbsolutePaths');

async function main() {
  // Delete the unnecessary files in order to reduce the size of the package
  console.log('delete file...');
  await Promise.all([
    path.join(__dirname, '..', 'node_modules', 'emoji-images', 'json'),
    path.join(__dirname, '..', 'node_modules', 'puppeteer-core', '.local-chromium')
  ].map(async dir => {
    await fs.promises.rm(dir, { recursive: true, force: true });
    console.log(dir);
  }));

  const results = await removeNPMAbsolutePaths(path.join(__dirname, '..', 'node_modules'), { force: true, fields: ['_where', '_args'] });
  results.forEach(result => {
    // Print only information about files that couldn't be processed
    if (!result.success) {
      console.error(result.err.message);
    }
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
