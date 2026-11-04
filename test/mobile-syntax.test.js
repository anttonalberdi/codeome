const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A syntax error in any phone script leaves the page stuck on "Connecting", so each one must compile.
const dir = path.join(__dirname, '../renderer/mobile');
for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
  test(`phone script ${file} is valid JavaScript`, () => {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(dir, file), 'utf8'), { filename: file }));
  });
}
