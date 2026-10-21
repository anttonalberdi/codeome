const test = require('node:test');
const assert = require('node:assert');
const { parseListing, passwordFiller } = require('../main/ssh');
const { parsePipe, parseNodes, SQ_FIELDS, SACCT_FIELDS, projectTag, submit, queue, history } = require('../main/slurm');
const ssh = require('../main/ssh');
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
  const out = '123|mapping|RUNNING|1:02:03|4:00:00|1|8|node12|standard|2026-10-09T10:00:00|/home/u/proj|32G|gres/gpu:1|codeome:proj-abcd1234\n124|qc|PENDING|0:00|1:00:00|1|4|(Priority)|standard|2026-10-09T10:05:00|/home/u/proj|||\n';
  const jobs = parsePipe(out, SQ_FIELDS);
  assert.strictEqual(jobs.length, 2);
  assert.strictEqual(jobs[0].id, '123');
  assert.strictEqual(jobs[1].reason, '(Priority)');
  assert.strictEqual(jobs[0].workdir, '/home/u/proj');
  assert.strictEqual(jobs[0].comment, 'codeome:proj-abcd1234');
  assert.strictEqual(jobs[1].comment, '');
});

test('sacct fields cover the requested columns', () => {
  const rows = parsePipe('99|assemble|FAILED|00:10:00|1:0|2026-10-09T09:00:00|2026-10-09T09:10:00|standard||16|/w|codeome:proj-abcd1234\n99.batch|batch|FAILED|00:10:00|1:0|||||16||\n', SACCT_FIELDS);
  assert.strictEqual(rows[0].exitcode, '1:0');
  assert.strictEqual(rows[1].id, '99.batch');
  assert.strictEqual(rows[0].comment, 'codeome:proj-abcd1234');
});

test('Slurm queries request comment fields', async () => {
  const original = ssh.exec;
  const commands = [];
  ssh.exec = async (_host, command) => { commands.push(command); return { code: 0, stdout: '', stderr: '' }; };
  try { await queue('hpc'); await history('hpc'); }
  finally { ssh.exec = original; }
  assert.match(commands[0], /%k/);
  assert.match(commands[1], /Comment%200/);
});

test('project tag is stable and separates paths with the same basename', () => {
  assert.strictEqual(projectTag('/a/My Project'), 'codeome:my-project-' + require('crypto').createHash('sha1').update('/a/My Project').digest('hex').slice(0, 8));
  assert.strictEqual(projectTag('/a/My Project'), projectTag('/a/My Project'));
  assert.notStrictEqual(projectTag('/a/My Project'), projectTag('/b/My Project'));
});

test('submission quotes the tag and script path and rejects unsafe tags', async () => {
  const original = ssh.exec;
  const commands = [];
  ssh.exec = async (_host, command) => { commands.push(command); return { code: 0, stdout: 'Submitted batch job 123', stderr: '' }; };
  try {
    const tag = projectTag('/a/My Project');
    assert.deepStrictEqual(await submit('hpc', "/home/u/project's job.sh", tag), { ok: true, message: 'Submitted batch job 123' });
    assert.strictEqual(commands[0], `cd ${q('/home/u')} && sbatch ${q('--comment=' + tag)} ${q("/home/u/project's job.sh")}`);
    assert.deepStrictEqual(await submit('hpc', '/home/u/job.sh', 'bad; touch /tmp/oops'), { error: 'Invalid project tag.' });
    assert.strictEqual(commands.length, 1);
  } finally { ssh.exec = original; }
});

test('scontrol nodes add up per partition, leaving out nodes that are down', () => {
  const out = [
    'NodeName=n1 Arch=x86_64 CPUAlloc=12 CPUTot=32 Gres=(null) RealMemory=512000 AllocMem=128000 State=MIXED Partitions=cpu,long CfgTRES=cpu=32,mem=512000M AllocTRES=cpu=12,mem=128000M',
    'NodeName=n2 CPUAlloc=0 CPUTot=32 RealMemory=512000 AllocMem=0 State=IDLE+DRAIN Partitions=cpu CfgTRES=cpu=32,mem=512000M AllocTRES=',
    'NodeName=g1 CPUAlloc=8 CPUTot=64 Gres=gpu:a100:4 RealMemory=1000000 AllocMem=64000 State=MIXED Partitions=gpu CfgTRES=cpu=64,mem=1000000M,gres/gpu=4,gres/gpu:a100=4 AllocTRES=cpu=8,mem=64000M,gres/gpu=1,gres/gpu:a100=1',
    'NodeName=n3 CPUAlloc=0 CPUTot=32 RealMemory=512000 AllocMem=0 State=DOWN* Partitions=long', ''
  ].join('\n');
  const r = parseNodes(out);
  const by = Object.fromEntries(r.partitions.map((p) => [p.name, p]));
  assert.deepStrictEqual(Object.keys(by), ['cpu', 'long', 'gpu']);
  assert.deepStrictEqual([by.cpu.nodes, by.cpu.offline, by.cpu.cpus, by.cpu.cpusUsed], [2, 1, 32, 12]);
  assert.deepStrictEqual([by.long.nodes, by.long.offline, by.long.cpus, by.long.memUsed], [2, 1, 32, 128000]);
  assert.deepStrictEqual([by.gpu.gpus, by.gpu.gpusUsed], [4, 1]);
  assert.deepStrictEqual([r.total.nodes, r.total.offline, r.total.cpus, r.total.cpusUsed], [4, 2, 96, 20]);
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
    'drwxr-xr-x    ? alice wheel    64 Oct  9 06:20 dir with space',
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

test('the saved HPC password is typed once, at the first ssh password prompt only', () => {
  const sent = [];
  const feed = passwordFiller('s3cret', (s) => sent.push(s));
  feed('** WARNING: connection is not using a post-quantum key exchange algorithm.\r\n');
  feed("alice@login.hpc.example.org's pass");
  assert.deepStrictEqual(sent, []);
  feed('word: ');
  assert.deepStrictEqual(sent, ['s3cret\r']);
  feed("\r\nPermission denied, please try again.\r\nalice@login.hpc.example.org's password: ");
  assert.deepStrictEqual(sent, ['s3cret\r']);
  const kbd = [];
  passwordFiller('s3cret', (s) => kbd.push(s))('(alice@login) Password: ');
  assert.deepStrictEqual(kbd, ['s3cret\r']);
  const other = [];
  const f2 = passwordFiller('s3cret', (s) => other.push(s));
  f2("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ");
  f2('Verification code: ');
  assert.deepStrictEqual(other, []);
  const none = [];
  passwordFiller('', (s) => none.push(s))('password: ');
  assert.deepStrictEqual(none, []);
});

test('the storage username goes in front of the host, replacing one already there', () => {
  const { target } = require('../main/sftp');
  assert.strictEqual(target('io.erda.dk', 'you@example.org'), 'you@example.org@io.erda.dk');
  assert.strictEqual(target('old@example.org@io.erda.dk', 'you@example.org'), 'you@example.org@io.erda.dk');
  assert.strictEqual(target('erda', ''), 'erda');
  assert.strictEqual(target('', 'you@example.org'), '');
});
