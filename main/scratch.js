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

function checkMove(from, to) {
  if (!isScratch(from)) throw new Error('Source must be Ideas.');
  if (typeof to !== 'string' || !to || isScratch(to)) throw new Error('Target must be a project folder.');
  let stat; try { stat = fs.statSync(to); } catch { throw new Error('Project folder not found.'); }
  if (!stat.isDirectory() || (fs.existsSync(scratchPath()) && fs.realpathSync(to) === fs.realpathSync(scratchPath())))
    throw new Error('Target must be a project folder.');
  return path.resolve(to);
}

module.exports = { dir, isScratch, checkMove };
