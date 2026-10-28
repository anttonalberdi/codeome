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

## Tools

Tools Codeome uses if present: `git`, `gh`, `rsync`, `ssh`, `sftp`, `quarto`, `R`, `Rscript`, `python3`, `tmux` (on the HPC), `claude`, `codex`. Settings shows which ones it found.
