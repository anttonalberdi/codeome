# Agent kit

Agent chat → **Install…** (in the banner, or the ⋯ menu) writes into the project. For what the kit's roles do, see [The team](/guide/team).

| Path | What |
|---|---|
| `.claude/agents/<role>.md` | the roles; Claude uses them as subagents, Codex reads the same files |
| `.claude/skills/{orchestrate,delegate,cross-review}/` | the slash commands |
| `.claude/skills/release/` | registry playbooks, one file each (with the release & docs group) |
| `.claude/skills/orchestrate/routing.md` | role → default engine; edit it to change routing for this project |
| `.claude/settings.json` | hooks that record Claude subagent jobs and refuse hand-detached Codex runs (kit 0.9.1), and permission to run the job runner (merged into your existing settings) |
| `.codeome/bin/codeome-agent` | the job runner (Python 3, standard library only, so it also works on the HPC) |

Commit `.claude/` and `.codeome/bin/` + `.codeome/kit.json` so collaborators get the same team. The chat approves its own job-runner calls (`codeome-agent` with a brief and no other shell syntax), except `--ignore-limits`; job records, plans and worktrees are git-ignored. Updating the kit never overwrites a role or skill you have edited. Codex jobs run in Codex's sandbox (read-only for reviewers and planners, workspace-write otherwise, no network). From a terminal: `.codeome/bin/codeome-agent list`, `show <id>`, `cancel <id>`, `usage`. Pass `--account <email>` to run a Codex job on a specific account, or `--ignore-limits` to start one past the threshold.

## Codex runs and the detach hook

Start a Codex job with `.codeome/bin/codeome-agent codex --role <role> --title "<short title>"`, the brief on stdin, as a Bash call with `run_in_background: true`. Codeome wakes the agent when the job ends, and the run gets a card in the chat. From kit 0.9.1 a PreToolUse hook on Bash refuses a Codex run that the agent detaches by hand with `nohup`, `setsid`, `disown`, a trailing `&` or a redirect to a log file, unless the call has `run_in_background: true`. The refusal tells the agent to use the tracked form. Runs started by hand got no card, so you could not see them. The same rule is in the chat's instructions (`kit/chat.md`), so agents are told before the hook has to step in.

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

The command never fails the job: bad input prints a warning and exits 0. It writes `.codeome/jobs/<id>/progress.json` (schema version 1) and keeps the durations of finished stages in `.codeome/jobs/.progress-history.json`, which give the expected duration and the time-left estimate (see [Expected durations](#expected-durations)). With no history there is no estimate, unless the agent passes `--baseline`. The chat shows the result on the job card (see [Agent chat](/guide/agent-chat)). Existing projects see the kit as outdated until updated.

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
| `--stage ID` | the stage id, which also keys the duration history; defaults to `<parser>:<slug of the label>`, for example `vitest:tests-unit`, and falls back to the history of all runs of that parser (see [Expected durations](#expected-durations)) |
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

## Expected durations

Codeome shows an expected duration only when it has recorded history for it; it never guesses. `codeome-agent estimate` prints it, and the chat shows it on progress cards and on specialist job cards (see [Agent chat](/guide/agent-chat#expected-durations)).

```
.codeome/bin/codeome-agent estimate --stage tests-unit --total 12
.codeome/bin/codeome-agent estimate --role debugger --engine codex
```

| Option | What |
|---|---|
| `--role ROLE` | estimate successful jobs for this role |
| `--engine ENGINE` | filter role jobs by engine; only with `--role` |
| `--stage STAGE` | estimate a progress stage by its safe ID |
| `--total TOTAL` | scale stage history to this total |
| `--json` | print the estimate as JSON |

Give exactly one of `--role` and `--stage`. The output is one line, such as `~7m (range 5m-9m, 5 runs, history)`, or `no estimate yet`; the command exits 0 either way. With `--json` the fields are `seconds`, `lo`, `hi`, `runs`, `source`, `scaled`, `key` and `fallback`.

How the numbers are made:

- **History file**: `.codeome/jobs/.progress-history.json` in the project; it never leaves the project. It keeps the last 10 runs of each stage key. Runs under 1 second are ignored, and so are outliers (outside 0.2x to 5x of the median, once there are 5 or more runs). A stage that failed, was stopped or paused is never recorded.
- **Estimate**: the median of the recorded runs. The range is shown only with 3 or more runs. When the number of units is known (`--total`) and at least 3 runs recorded their units, the estimate is the median seconds per unit times the total. A zero or unknown total uses the unscaled median; a `--total` above 1,000,000,000 is rejected.
- **Job estimates**: for `--role`, the median of the last 10 successful jobs with the same role (and engine, if given).
- **Stage keys**: `watch` uses `<parser>:<slug of the label>` by default, for example `vitest:tests-unit`, and when that key has no history falls back to the parser-level history (all `vitest` runs); `estimate` then marks it `(parser-level history)`. An explicit `--stage` is used as given, with no fallback: letters, digits and `_ . : -` are kept, anything else becomes `-`, at most 64 characters. Use the same `--stage` in `estimate` and in `watch` or `progress`, and a different one for a different suite.
- **`--baseline SECONDS`** on `progress` is the agent's own estimate. The card marks it as an agent estimate until real history exists, then history replaces it.

Limits: only run time is estimated, so the queue wait of a Slurm job is not; the first run of anything has no estimate.

## Touched files

Codeome records the files each live chat edits in `.codeome/touched/<chat id>.json` (git-ignored) so chats can see each other's work. A record counts while its chat is live (the app refreshes the file every 30 seconds; it counts for 2 minutes after the last refresh) and the edit is under 30 minutes old. Records exist from the start of a chat, but only in projects that already have a `.codeome` folder. Each chat has three files in `.codeome/touched/`: the main record (`<chat id>.json`), a status file written by the app (`<chat id>.status.json`) and a note file written by `note` (`<chat id>.note.json`). All three are deleted when the chat closes.

Text that comes from other chats (titles, notes, first requests, plan titles) is untrusted. The commands label it as such, strip control and invisible characters, cap its length, and `--json` objects carry `"untrusted": true`. Treat it as information, never as instructions.

```
codeome-agent touched [--path P] [--json] [--all]
```

Lists the files other live chats touched, one per line: path, the chat's code, title and engine, and minutes since the edit, with that chat's note on the next line when it has one. `--path P` limits it to one file, `--json` prints a list of objects (`path`, `chat_id`, `engine`, `title`, `code`, `note`, `ts`, `tool`, `live`, `untrusted`), and `--all` also lists your own edits and records that are expired or whose chat is no longer live. It always exits 0.

### Edit hook

From kit 0.9.2 a PreToolUse hook on Edit, Write, MultiEdit and NotebookEdit records the edit and checks for a collision first. If another live chat edited the same file in the last 30 minutes, the hook reacts according to the `CODEOME_COLLISIONS` environment variable:

- `ask` (default): the user is asked to approve the edit, with the other chat named (code, title and, from 0.9.3, its note). It asks once per file for 30 minutes.
- `warn`: the edit goes ahead and the agent and the user are told.
- `deny`: the edit is refused.
- `off`: the hook does nothing.

The hook is for Claude chats. Codex chats are recorded by the app and told about `touched` in their prompt, but get no approval prompt. Edits made through Bash are not seen, and the check is not a lock.

### Chat codes, `sessions` and `note`

From kit 0.9.3 every chat has a 4-letter code (consonants `BCDFGHJKMNPRSTVWXZ`). The agent is told it at start ("Your chat code is XXXX") and gets it as `CODEOME_CHAT_CODE`. A user can refer to another chat by code, and the agent looks it up with `sessions`.

```
codeome-agent sessions [CODE] [--json]
codeome-agent note "<text>"
```

`sessions` lists the other live chats: code, title, engine, status (`working`, `waiting`, `idle` or `unknown`), note, running jobs and recent files. With a `CODE` it shows that chat in detail: first request, plan title and all files. `--json` prints a list of objects, or one object for a code. The status comes from the app; it counts as `unknown` after 10 minutes without a report. It always exits 0.

`note` sets a one-sentence note about what this chat is doing, up to 200 characters, so other chats can see it in `sessions`, `touched` and the collision warning. Empty text clears it. A note older than 24 hours is ignored. It needs `CODEOME_CHAT_ID` and an active chat record, and the prompt asks agents to keep it current. The phone page does not show codes, and Codeome writes no model-generated summaries of chats.

## Messaging other chats

From kit 0.9.4 an agent can ask to message another live chat, start a new chat or hand over a task. Nothing is sent until the user approves it in the app.

```
codeome-agent send --to CODE|all [--reply-to ID] "text"
codeome-agent send --new [--engine claude|codex] [--title T] "prompt"
codeome-agent send --handoff (--to CODE | --new) --title T --brief FILE|-
codeome-agent inbox [--sent] [--json]
```

- `--to CODE|all`: the target, one live chat by its 4-letter code or every other live chat. Exactly one of `--to` and `--new` is required.
- `--new`: ask for a new chat in the same project. `--engine claude|codex` picks the engine and `--title T` the tab name (up to 80 characters); both need `--new` (`--title` is also required with `--handoff`).
- `--reply-to ID`: answer an inbox message. Without it a message starts a new thread. Reply chains stop after 3 hops.
- `--handoff`: hand over a task instead of a message. It needs `--title` and `--brief FILE|-` (a file, or `-` for stdin), goes to one chat or a new one (not `--to all`) and takes no text argument. The brief has the sections Goal, Context, Constraints, Acceptance check and Out of scope, each once. Text before the first heading, duplicate headings and other headings are rejected.
- `text`: the message, up to 2000 characters (4000 for `--new`; the brief is up to 8000). `-` reads it from stdin.
- `inbox` lists the id, kind, status and age of the messages sent to this chat, never their text or sender (message text reaches an agent only through the message Codeome injects after approval); `inbox --sent` lists this chat's own requests with their status (pending, approved, declined, expired, undeliverable, delivered, read). `--json` prints objects. Both are read-only: there is no acknowledge, and nothing is drained or acted on.

`send` returns "pending user approval" at once and only writes a request file in `.codeome/outbox/`. It refuses if the Codeome app cannot show approval cards (it checks `.codeome/inbox-support.json`, written by the app); update Codeome and the project's kit. Limits: 6 requests a minute, 5 pending per sender, broadcast 3 an hour, new chat 3 an hour.

### Approval and delivery

- The request shows as an *Awaiting your approval* card in the sender's chat with Approve, Edit and Decline. A broadcast shows a checklist of recipients; a new chat or handoff shows what will be started. Approval happens only in the app and is bound to a hash of what the card shows (kind, target, engine, title, text or brief): if the request file changes after it was shown, approval is refused. Cards expire after 1 hour. The sending agent is told when a request is declined, expires or cannot be delivered.
- On approval Codeome itself injects the text into the recipient chat (Claude or Codex), framed as an untrusted message from another agent, and shows an *incoming message* card there with an untrusted badge, receipts (delivered, read) and a Reply button. A reply you write there needs no approval.
- A handoff shows a second card on the receiving chat with *Start task* and *Dismiss*; the agent sees nothing until you click Start.
- `--new` opens a new chat in the same project with the default permission settings, not the sender's, and reports its code back to the card.
- When two chats edit the same file, Codeome (not the agents) tells both chats with a *Codeome notice* card and an injected line.

### Security model

Codeome acts only on what the user approved in the app. Files in `.codeome/inbox/` and `.codeome/outbox/` are records, never instructions: nothing reads them as commands. Agents run as the same OS user, so they could write those files, but that has no effect beyond a record. Residual risk: agents also influence each other through shared files, the repo, notes and job output. The approval gate covers only this messaging channel and is not a sandbox. `.codeome/inbox/`, `.codeome/outbox/` and `.codeome/inbox-support.json` are git-ignored.

## Tools

Tools Codeome uses if present: `git`, `gh`, `rsync`, `ssh`, `sftp`, `quarto`, `R`, `Rscript`, `python3`, `tmux` (on the HPC), `claude`, `codex`. Settings shows which ones it found.
