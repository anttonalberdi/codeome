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
| `--plan id:Label,...` | declare all stages up front |

The command never fails the job: bad input prints a warning and exits 0. It writes `.codeome/jobs/<id>/progress.json` (schema version 1) and keeps the last five durations of each stage in `.codeome/jobs/.progress-history.json`, which give the baseline and the time-left estimate. With no history there is no estimate. The chat shows the result on the job card (see [Agent chat](/guide/agent-chat)). Existing projects see the kit as outdated until updated.

### Watching a log

For a long test run or build, the agent starts `watch` once in the background instead of calling `progress` repeatedly (kit 0.8.0). It tails a log, parses done/total and writes `.codeome/jobs/.tasks/<key>/progress.json`, which the chat shows as a card of its own.

```
.codeome/bin/codeome-agent watch --log <log-path> --pid <pid> --parser vitest --total 12 --label "Tests" --task vitest-a3f
```

| Option | What |
|---|---|
| `--log FILE` | the log to follow |
| `--parser` | `vitest`, `pytest`, `tsc` or `regex` (below) |
| `--total N` | the number of units; required for `vitest`, and for `regex` unless the pattern has a `total` group |
| `--label TEXT` | the name on the card |
| `--task KEY` | the card's key: letters, digits, `.`, `_` or `-`, at most 64 characters; use a short random suffix to keep it unique |
| `--pid P` | the process that writes the log; the watch ends when it does |
| `--stage ID` | the stage id, which also keys the duration history; defaults to the parser name |
| `--regex PATTERN` | for the `regex` parser |
| `--timeout SECONDS` | give up after this long (default 21600, six hours) |
| `--quiet` | no final line |

| Parser | Reads | Notes |
|---|---|---|
| `vitest` | one line per test file | needs `--reporter=verbose`; counts unique test files, so `--total` is the number of test files |
| `pytest` | the `[ 42%]` markers | pass `--pid`, because `-q` prints no summary line |
| `tsc` | `tsc -b --verbose` | uses `N of M`, or counts the `Building project` and `is up to date` lines, so `--total` is the number of projects |
| `regex` | your pattern | a named group `done` and, optionally, `total`; at most 200 characters, no backreferences or nested quantifiers; matching runs in a separate process that is stopped after 2 seconds |

The run counts as failed when the log shows a failure: a failed or `FAIL` test file or a non-zero `failed` count in the Vitest summary, `failed` or `error` in the pytest summary line, or an `error TS` line from tsc. Only those summary and file lines count, so a passing test whose name contains "failed" does not fail the run. It also fails if the watch times out, is stopped, or ends before reaching the total.

Start the command and the watch in two Bash calls: first the command, with its output going to a temp file and its pid printed, then `watch` in a separate call with `run_in_background: true` (the example is in the project's chat instructions). `watch` never exits non-zero, never signals the process it watches, and prints nothing but one final line (`--quiet` removes it); problems go to stderr as warnings.

Codeome's own task files under `.codeome/jobs/.tasks/` are pruned when a watch starts: folders older than 7 days, or beyond the newest 50, are removed. `.codeome/jobs/` is git-ignored. Slice 1's `progress` command is unchanged. Snakemake and Slurm parsers are not included. Projects with an older kit see it as outdated until updated.

## Tools

Tools Codeome uses if present: `git`, `gh`, `rsync`, `ssh`, `sftp`, `quarto`, `R`, `Rscript`, `python3`, `tmux` (on the HPC), `claude`, `codex`. Settings shows which ones it found.
