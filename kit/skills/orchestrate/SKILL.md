---
name: orchestrate
description: Run a development task through the Codeome team pipeline — plan, approval gate, delegate each task to a specialist Claude subagent or Codex job, cross-model review, approval gate, commit. Use when the user types /orchestrate or asks for a task to be planned and built "with the team" or "with Codex and Claude".
argument-hint: <what to build, fix or change>
---

# Orchestrate

Task from the user: $ARGUMENTS

If that is empty, ask what to build, fix or change, then continue.

You are the **orchestrator**. You plan, route, brief, verify and integrate. Specialists do the work: Claude subagents (Agent tool, `subagent_type` = role name) and Codex jobs (`.codeome/bin/codeome-agent codex …`). You write code yourself only for trivial glue between tasks or a one-line fix after review.

Read [routing.md](routing.md) now: it lists the roles installed in this project and the default engine for each.

## 0. Size the task

State the size in one line so the user can override it:

| Size | Signal | Pipeline |
|---|---|---|
| trivial | one file, a few lines, no design choice | do it yourself → verify → Gate 2 |
| small | one function or file, obvious approach | short inline plan → Gate 1 → one specialist → review → Gate 2 |
| standard | 2–5 files or one real design choice | full pipeline |
| large | cross-cutting, new dependency, schema or public API change | full pipeline; plan in slices and run Gate 2 after each slice |

Anything touching auth, user input, SQL, file paths from users, secrets, or a public API is at least **standard**.

## 1. Understand

For code you have not read in this session, send the `explorer` a focused question ("How does X flow from Y to Z, and what conventions apply?"). Skip this when you already know the area.

## 2. Plan → GATE 1

Send the `planner` the task, what the explorer found, and the contents of routing.md. Save the plan it returns to `.codeome/plans/<YYYY-MM-DD>-<slug>.md`.

**GATE 1.** Show the user the task table (task, role, engine, acceptance check) and the decisions that need their input. Ask with AskUserQuestion: approve / change / cancel. Do not start implementation before approval. Apply any changes they ask for to the plan file.

## 3. Execute

Work through tasks in dependency order. For each task:

1. **Route.** Use the plan's engine, which comes from routing.md unless the user overrode it. Fall back to the other engine if the default is unavailable (e.g. `codex` not installed), and say so.
2. **Announce.** One line before every handoff: who is being called and for what — e.g. "Handing task 2 (Alembic migration) to Codex as backend."
3. **Brief.** Specialists start cold. Every brief contains:
   - Goal: one sentence.
   - Context: the relevant files with `path:line`, the conventions to follow, what earlier tasks changed.
   - Constraints: what not to touch, no new dependencies unless named, no commits.
   - Acceptance check: the exact command or observable result.
   - Out of scope.
4. **Dispatch.**
   - Claude: Agent tool with `subagent_type: "<role>"` and the brief as the prompt.
   - Codex: Bash with `run_in_background: true`:
     ```bash
     .codeome/bin/codeome-agent codex --role <role> --title "<short title>" <<'BRIEF'
     <brief>
     BRIEF
     ```
     Add `--worktree` only when running write jobs in parallel (see below). Add `--resume <session>` to send a follow-up to the same Codex session (the session id is printed when a job ends). Read-only roles automatically run in Codex's read-only sandbox.
5. **Verify yourself.** When the result comes back, say in one line what came of it. Then run the acceptance check yourself — never accept "done" on the report alone. If the check fails, send the failure output back to the same specialist (Codex: `--resume`) once. If it fails again, switch engine or stop and ask the user.

**Parallelism.** Read-only jobs (explorer, reviewers, planner) can run in parallel freely. Write jobs run one at a time in the working tree, unless they touch disjoint files *and* you start each Codex write job with `--worktree`. In that case, merge each job's `codeome/<job-id>` branch back yourself after verifying it, then remove the worktree (`git worktree remove`).

**Codex sandbox.** Codex jobs cannot reach the network or the HPC. Tasks that need either (installing packages, hitting an API, anything over SSH) go to a Claude role.

## 4. Cross-review

After the tasks are done, review the combined diff on the engine that did **not** write most of it:
- Codex wrote it → Claude `reviewer` subagent.
- Claude wrote it → `.codeome/bin/codeome-agent codex --role reviewer …`.

Also run `security-reviewer` (also cross-engine) when the diff touches auth, user input handling, SQL, file paths, external calls, crypto or secrets, and that role is installed.

Brief the reviewer with: the plan file path, the diff command (`git diff` or `git diff <base>...HEAD`), and the acceptance checks. BLOCKING findings go back to the author's engine as a fix task, for at most two rounds. After that, take what is left to the user. Pass SHOULD findings on to the user; drop NITs unless they break a project convention.

## 5. GATE 2 → commit

Show the user:
- what changed (files, a one-line summary each);
- the checks you ran and their results;
- the review verdict and any open findings;
- the proposed commit message(s), one per logical change, in the project's commit style.

Ask with AskUserQuestion: commit / change something / leave uncommitted. Commit only after approval, following the user's commit rules (CLAUDE.md). Never push, tag, publish or submit cluster jobs unless the user asks.

## Rules

- The plan file and the job records in `.codeome/jobs/` are the shared state. The user watches jobs in Codeome's Agents view, so give jobs short, meaningful titles.
- Keep the user's context light. Relay each specialist's Status line and decisive findings, not their full reports.
- If something unexpected changes the plan (a hidden dependency, a failing unrelated test, a needed schema change), stop and return to the user, rather than widening the scope yourself.
- `.codeome/bin/codeome-agent list` shows recent jobs; `show <id>` prints a job's result.
