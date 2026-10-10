const test = require('node:test');
const assert = require('node:assert');
const { parseListing } = require('../main/ssh');
const { parsePipe, SQ_FIELDS, SACCT_FIELDS } = require('../main/slurm');
const { q } = require('../main/util');

test('remote listing parses find -printf output and sorts folders first', () => {
  const out = '/home/u/proj\nf\t1200\t1728480000.5\tanalysis.R\nd\t4096\t1728480000\tdata\nl\t10\t1728480000\tlink\nf\t5\t1728480000\twith\ttab.txt\n';
  const r = parseListing(out);
  assert.strictEqual(r.cwd, '/home/u/proj');
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['data', 'analysis.R', 'link', 'with\ttab.txt']);
  assert.strictEqual(r.entries[0].dir, true);
  assert.strictEqual(r.entries[1].size, 1200);
  assert.strictEqual(r.entries[1].mtime, 1728480000500);
});

test('squeue pipe output maps to fields', () => {
  const out = '123|mapping|RUNNING|1:02:03|4:00:00|1|8|node12|standard|2026-10-09T10:00:00|/home/u/proj\n124|qc|PENDING|0:00|1:00:00|1|4|(Priority)|standard|2026-10-09T10:05:00|/home/u/proj\n';
  const jobs = parsePipe(out, SQ_FIELDS);
  assert.strictEqual(jobs.length, 2);
  assert.strictEqual(jobs[0].id, '123');
  assert.strictEqual(jobs[1].reason, '(Priority)');
  assert.strictEqual(jobs[0].workdir, '/home/u/proj');
});

test('sacct fields cover the requested columns', () => {
  const rows = parsePipe('99|assemble|FAILED|00:10:00|1:0|2026-10-09T09:00:00|2026-10-09T09:10:00|standard||16|/w\n99.batch|batch|FAILED|00:10:00|1:0|||||16|\n', SACCT_FIELDS);
  assert.strictEqual(rows[0].exitcode, '1:0');
  assert.strictEqual(rows[1].id, '99.batch');
});

test('shell quoting survives single quotes', () => {
  assert.strictEqual(q("it's here"), "'it'\\''s here'");
});

const { parseSftpListing, sq, transferBatch } = require('../main/sftp');

test('sftp listing parses pwd and ls -lan output', () => {
  const out = [
    'sftp> cd "/home/u/archive"',
    'sftp> pwd',
    'Remote working directory: /home/u/archive',
    'sftp> ls -lan',
    'drwxr-xr-x    ? 1000     1000          160 Oct 10 06:20 .',
    'drwx------    ? 1000     1000          128 Oct 10 06:20 ..',
    '-rw-r--r--    ? 1000     1000            3 Oct 10 06:20 a "q" *.txt',
    'drwxr-xr-x    ? user         wheel    64 Oct  9 06:20 dir with space',
    '-rw-r--r--    1 1000     2023            0 Jan  2  2023 old.R',
    'lrwxrwxrwx    1 0        0              11 Dec 31 23:00 shared'
  ].join('\n');
  const r = parseSftpListing(out, new Date(2026, 9, 10, 12, 0));
  assert.strictEqual(r.cwd, '/home/u/archive');
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['dir with space', 'a "q" *.txt', 'old.R', 'shared']);
  assert.strictEqual(r.entries[0].dir, true);
  assert.strictEqual(r.entries[1].size, 3);
  // A numeric group isn't mistaken for the size.
  assert.strictEqual(r.entries[2].size, 0);
  assert.strictEqual(new Date(r.entries[2].mtime).getFullYear(), 2023);
  // "Dec 31 23:00" without a year, seen in October, was last December.
  assert.strictEqual(new Date(r.entries[3].mtime).getFullYear(), 2025);
  assert.strictEqual(r.entries[3].link, true);
});

test('sftp batch paths quote backslashes and double quotes only', () => {
  assert.strictEqual(sq('/a/b "c"\\d *.txt'), '"/a/b \\"c\\"\\\\d *.txt"');
  assert.throws(() => sq('a\nb'));
  assert.strictEqual(transferBatch('up', '/x/data', '/arch'), 'progress\nput -R "/x/data" "/arch/"\n');
});
