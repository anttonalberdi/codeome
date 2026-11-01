const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PHONE_BASH_ALLOW } = require('../main/remote-server');

const config = fs.readFileSync(path.join(__dirname, '../main/config.js'), 'utf8');
const settings = fs.readFileSync(path.join(__dirname, '../renderer/js/settings.js'), 'utf8');

function literal(source, pattern) {
  const match = source.match(pattern);
  assert.ok(match, `missing default: ${pattern}`);
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${match[1]})`)));
}

test('phone Bash defaults in config, settings reset, and server stay aligned', () => {
  const configured = literal(config, /phoneBashAllow: (\[[^\]]+\])/);
  const reset = literal(settings, /const PHONE_BASH_DEFAULTS = (\[[^\]]+\])/);
  assert.deepEqual(configured, reset);
  assert.deepEqual(configured, PHONE_BASH_ALLOW);
});

test('phone desktop approval defaults in config and settings reset stay aligned', () => {
  const configured = literal(config, /requireDesktopFor: (\[[\s\S]*?\n    \])/);
  const reset = literal(settings, /const PHONE_RULE_DEFAULTS = (\[[\s\S]*?\n  \])/);
  assert.deepEqual(configured, reset);
});
