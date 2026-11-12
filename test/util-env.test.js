const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { augmentedEnv } = require('../main/util');

function oldAugmentedEnv(extra, env, home) {
  const extraPaths = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    path.posix.join(home, '.local/bin'), path.posix.join(home, 'bin'),
    path.posix.join(home, 'miniforge3/bin'), path.posix.join(home, 'miniconda3/bin'), path.posix.join(home, 'anaconda3/bin'),
    path.posix.join(home, '.npm-global/bin'), path.posix.join(home, '.cargo/bin'),
    '/Applications/quarto/bin', '/Library/Frameworks/R.framework/Resources/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'
  ];
  const current = (env.PATH || '').split(':').filter(Boolean);
  const merged = [...new Set([...current, ...extraPaths])].join(':');
  return { ...env, PATH: merged, LANG: env.LANG || 'en_US.UTF-8', ...extra };
}

test('darwin and linux environments match the old algorithm byte for byte', () => {
  const home = '/Users/sample';
  const samples = [
    { env: { HOME: '/different' }, extra: {} },
    { env: { PATH: '/bin:/opt/homebrew/bin:/bin::/custom', LANG: 'fr_CH.UTF-8' }, extra: { CUSTOM: '1' } },
    { env: { PATH: `${home}/.cargo/bin:/usr/bin:/x`, LANG: '' }, extra: { PATH: '/override', CUSTOM: '2' } }
  ];
  for (const platform of ['darwin', 'linux']) {
    for (const { env, extra } of samples) {
      assert.equal(
        JSON.stringify(augmentedEnv(extra, { platform, env, home })),
        JSON.stringify(oldAugmentedEnv(extra, env, home))
      );
    }
  }
});

test('win32 uses Path and configured tool dirs with case-insensitive deduplication', () => {
  const home = 'C:\\Users\\me';
  const env = {
    USERPROFILE: home, ProgramFiles: 'C:\\Program Files', APPDATA: `${home}\\AppData\\Roaming`,
    Path: 'C:\\Tools;c:\\TOOLS;C:\\Program Files\\Git\\CMD;;'
  };
  const result = augmentedEnv({ CUSTOM: '1' }, { platform: 'win32', env, home });
  assert.deepEqual(Object.keys(result).filter(key => key.toLowerCase() === 'path'), ['Path']);
  assert.equal(result.Path, [
    'C:\\Tools', 'C:\\Program Files\\Git\\CMD',
    'C:\\Program Files\\Git\\usr\\bin', `${home}\\AppData\\Roaming\\npm`,
    `${home}\\.local\\bin`, `${home}\\bin`,
    `${home}\\miniforge3\\Scripts`, `${home}\\miniforge3`,
    `${home}\\miniconda3\\Scripts`, `${home}\\miniconda3`,
    `${home}\\anaconda3\\Scripts`, `${home}\\anaconda3`,
    `${home}\\.npm-global\\bin`, `${home}\\.cargo\\bin`
  ].join(';'));
  assert.equal(result.CUSTOM, '1');
  assert.equal(result.CHERE_INVOKING, '1');
  assert.equal(result.MSYS_NO_PATHCONV, '1');
  assert.equal(Object.hasOwn(result, 'LANG'), false);

  const overridden = augmentedEnv({ PATH: 'D:\\Custom' }, { platform: 'win32', env, home });
  assert.deepEqual(Object.keys(overridden).filter(key => key.toLowerCase() === 'path'), ['Path']);
  assert.equal(overridden.Path, 'D:\\Custom');
});
