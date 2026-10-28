# Agent kit

Agent chat → **Install…** (in the banner, or the ⋯ menu) writes into the project. For what the kit's roles do, see [The team](/guide/team).

| Path | What |
|---|---|
| `.claude/agents/<role>.md` | the roles; Claude uses them as subagents, Codex reads the same files |
| `.claude/skills/{orchestrate,delegate,cross-review}/` | the slash commands |
| `.claude/skills/release/` | registry playbooks, one file each (with the release & docs group) |
| `.claude/skills/orchestrate/routing.md` | role → default engine; edit it to change routing for this project |
| `.claude/settings.json` | hooks that record Claude subagent jobs, and permission to run the job runner (merged into your existing settings) |
| `.codeome/bin/codeome-agent` | the job runner (Python 3, standard library only, so it also works on the HPC) |

Commit `.claude/` and `.codeome/bin/` + `.codeome/kit.json` so collaborators get the same team. The chat approves its own job-runner calls (`codeome-agent` with a brief and no other shell syntax), except `--ignore-limits`; job records, plans and worktrees are git-ignored. Updating the kit never overwrites a role or skill you have edited. Codex jobs run in Codex's sandbox (read-only for reviewers and planners, workspace-write otherwise, no network). From a terminal: `.codeome/bin/codeome-agent list`, `show <id>`, `cancel <id>`, `usage`. Pass `--account <email>` to run a Codex job on a specific account, or `--ignore-limits` to start one past the threshold.

## Job progress

Specialists report the stages of a job with `.codeome/bin/codeome-agent progress` (kit 0.7.0). The job id comes from `--job` or `$CODEOME_JOB_ID`: Codex jobs get it in their environment, and Claude subagents are told it when they start.

```
.codeome/bin/codeome-agent progress --plan inspect:Inspect,edit:Edit,test:Test
.codeome/bin/codeome-agent progress --stage edit --state running --done 3 --total 12 --unit files
.codeome/bin/codeome-agent progress --stage edit --state done
```

| Option | What |
|---|---|
| `--job ID` | the job; defaults to `$CODEOME_JOB_ID` |
| `--stage ID`, `--label TEXT` | the stage to update, and its display name |
| `--state` | `waiting`, `running`, `done` or `failed` |
| `--done N --total M --unit U` | countable work, shown as a bar |
| `--baseline SECONDS` | expected duration, if the agent knows it |
| `--plan id:Label,...` | declare all stages up front; quote the whole value when a label has spaces |

The command never fails the job: bad input prints a warning and exits 0. It writes `.codeome/jobs/<id>/progress.json` (schema version 1) and keeps the last five durations of each stage in `.codeome/jobs/.progress-history.json`, which give the baseline and the time-left estimate. With no history there is no estimate. The chat shows the result on the job card (see [Agent chat](/guide/agent-chat)). Existing projects see the kit as outdated until updated.

### Watching a log

For a long test run or build, the agent starts `watch` once in the background instead of calling `progress` repeatedly (kit 0.8.0). It tails a log, parses done/total and writes `.codeome/jobs/.tasks/<key>/progress.json`, which the chat shows as a card of its own.

```
.codeome/bin/codeome-agent watch --log <log-path> --pid <pid> --parser vitest --total 12 --label "Tests" --task vitest-a3f
```

| Option | What |
|---|---|
| `--log FILE` | the log to follow |
| `--remote-log /ABS/PATH` | a log on the HPC instead of `--log` (kit 0.9.0; see below) |
| `--jobs ID[,ID...]` | for `--parser slurm`: the Slurm job or array ids to follow (kit 0.9.0; see below) |
| `--parser` | `vitest`, `pytest`, `tsc`, `snakemake`, `slurm` or `regex` (below) |
| `--total N` | the number of units; required for `vitest`, and for `regex` unless the pattern has a `total` group; optional for `snakemake` and `slurm`, which learn it themselves |
| `--label TEXT` | the name on the card |
| `--task KEY` | the card's key: letters, digits, `.`, `_` or `-`, at most 64 characters; use a short random suffix to keep it unique |
| `--pid P` | the process that writes the log; the watch ends when it does |
| `--stage ID` | the stage id, which also keys the duration history; defaults to the parser name |
| `--regex PATTERN` | for the `regex` parser |
| `--timeout SECONDS` | give up after this long (default 21600, six hours; 259200, 72 hours, for `slurm` and `--remote-log`) |
| `--quiet` | no final line |

| Parser | Reads | Notes |
|---|---|---|
| `vitest` | one line per test file | needs `--reporter=verbose`; counts unique test files, so `--total` is the number of test files |
| `pytest` | the `[ 42%]` markers | pass `--pid`, because `-q` prints no summary line |
| `tsc` | `tsc -b --verbose` | uses `N of M`, or counts the `Building project` and `is up to date` lines, so `--total` is the number of projects |
| `snakemake` | the `N of M steps` lines of a Snakemake log | units are steps; `--total` is optional because the log carries it; works for the local and the Slurm executor (below) |
| `slurm` | `sacct` on the HPC | units are tasks of the jobs in `--jobs`; no log file (below) |
| `regex` | your pattern | a named group `done` and, optionally, `total`; at most 200 characters, no backreferences or nested quantifiers; matching runs in a separate process that is stopped after 2 seconds |

The run counts as failed when the log shows a failure: a failed or `FAIL` test file or a non-zero `failed` count in the Vitest summary, `failed` or `error` in the pytest summary line, or an `error TS` line from tsc. Only those summary and file lines count, so a passing test whose name contains "failed" does not fail the run. It also fails if the watch times out, is stopped, or ends before reaching the total.

Start the command and the watch in two Bash calls: first the command, with its output going to a temp file and its pid printed, then `watch` in a separate call with `run_in_background: true` (the example is in the project's chat instructions). `watch` never exits non-zero, never signals the process it watches, and prints nothing but one final line (`--quiet` removes it); problems go to stderr as warnings.

#### Snakemake logs

`--parser snakemake --log <file>` follows a local Snakemake log: the stdout of the run tee'd to a file, or `.snakemake/log/*.snakemake.log`. It counts the `N of M steps` lines, so `--total` is optional. Retries are followed. A failed run ends failed; a dry run and `Nothing to be done` end done. Pass `--pid` for a local run so the end is certain: text that a rule prints to the log can otherwise imitate a summary line.

#### Slurm jobs and HPC logs

Kit 0.9.0 can also follow work on the HPC. `watch` still runs on the Mac, never on the HPC, and nothing is installed there: it goes through the ssh connection Codeome already holds for the chat.

```
.codeome/bin/codeome-agent watch --parser slurm --jobs <job-id> --label "Array" --task array-a3f
.codeome/bin/codeome-agent watch --remote-log /abs/path/run.log --parser snakemake --label "Workflow" --task snake-b4e
```

`--parser slurm --jobs ID[,ID...]` polls `sacct -X -n -P -j <ids> -o JobID,State` every 30 seconds. An id is digits only, optionally `_<n>` for one array task; a plain array id expands to its tasks. At most 50 ids, and no bracket ranges. Done is the number of `COMPLETED` tasks; the total is `--total`, or the tasks seen so far (collapsed pending rows are counted). The watch ends when every task is in a final state, and the run counts as failed if any task ended `FAILED`, `TIMEOUT`, `OUT_OF_MEMORY`, `NODE_FAIL`, `BOOT_FAIL`, `DEADLINE`, `CANCELLED` or `REVOKED`. `--pid` and `--log` are not used.

`--remote-log /abs/path --parser ...` follows a log on the HPC, read-only, every 5 seconds. The path is absolute and made of plain characters, and must be a regular file. `--pid` is not used, so the watch ends on the parser's summary or on `--timeout`. Pass `--timeout SECONDS` for runs longer than the default.

Problems end the watch with a reason: three failed polls give "lost connection to HPC", three empty `sacct` polls give "no job data", and if the connection is not available it ends at once with "HPC connection not available", without trying to log in. The remote modes need a connected HPC (Settings > HPC). The app gives the Claude agent's shell `CODEOME_HPC_HOST` and `CODEOME_HPC_SOCKET` when a host is configured, so they are for Claude chats and the Claude `hpc-operator`; Codex chats and jobs have no network and use only the local forms. Nextflow and array summaries beyond the card are not included.

Codeome's own task files under `.codeome/jobs/.tasks/` are pruned when a watch starts: folders older than 7 days, or beyond the newest 50, are removed. `.codeome/jobs/` is git-ignored. Slice 1's `progress` command is unchanged. Projects with an older kit see it as outdated until updated.

## Tools

Tools Codeome uses if present: `git`, `gh`, `rsync`, `ssh`, `sftp`, `quarto`, `R`, `Rscript`, `python3`, `tmux` (on the HPC), `claude`, `codex`. Settings shows which ones it found.
