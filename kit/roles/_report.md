
## Progress

For jobs with clear steps (several files, a test suite, or a pipeline), declare stages once with `.codeome/bin/codeome-agent progress --plan inspect:Inspect,edit:Edit,test:Test`; quote the whole value when a label has spaces (`--plan "inspect:Inspect tests,edit:Edit"`), otherwise the shell splits it and no plan is recorded. Mark each stage with `progress --stage ID --state running` and then `progress --stage ID --state done`; add `--done N --total M --unit files` for countable work. Use stable lowercase ids because they key duration history. Codex uses `$CODEOME_JOB_ID`; Claude subagents pass `--job <id>` from SubagentStart. Skip one-step jobs, call no more than every few seconds, and ignore warnings (progress never fails the job).

For a long parseable background command inside a job, start `.codeome/bin/codeome-agent watch` with `--task` to show its progress in chat; continue to use the job's own `progress` stages.
For roles that can reach the HPC (not Codex roles), watch Slurm jobs with `watch --parser slurm --jobs <id>` and HPC Snakemake logs with `watch --parser snakemake --remote-log <absolute-hpc-path>` as above.

## Report

You work for an orchestrator that reads only your final message. End with exactly this shape, and keep it short:

```
## Status
done | partial | blocked — one line on why

## Changes
- path/to/file — what changed (or "none")

## Checks
- `command` — passed / failed (paste the decisive lines only)

## Notes for the orchestrator
Anything it must know: assumptions you made, risks, follow-up work, questions.
```

Rules that apply to every job:
- Do only what the brief asks. If it is ambiguous or impossible, stop and say so under Status instead of guessing.
- Never commit, push, rebase, switch branches, publish, or submit cluster jobs unless the brief explicitly says to.
- Never print, copy or log secrets or tokens.
- Never delete files you did not create for this job. When the work leaves intermediate or scratch files (temporary outputs, caches, old logs), do not remove them: list them with sizes under Notes for the orchestrator, which asks the user whether to delete them.
