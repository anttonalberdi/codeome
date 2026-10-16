const fs = require('fs');
const path = require('path');
const usage = require('./usage');

const scratchPath = () => path.join(usage.home(), 'scratch');

function dir() {
  const folder = scratchPath();
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function isScratch(p) {
  return typeof p === 'string' && !!p && path.resolve(p) === path.resolve(scratchPath());
}

module.exports = { dir, isScratch };
