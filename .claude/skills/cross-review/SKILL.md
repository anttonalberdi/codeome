---
name: cross-review
description: Review the current changes with the engine that did not write them — Codex reviews Claude's work, Claude reviews Codex's — and add a security review when the diff warrants it. Use when the user types /cross-review or asks for a second-opinion review.
argument-hint: [claude|codex] [base-ref]
---

# Cross-review

Arguments: $ARGUMENTS

1. **Scope.** If a base ref was given, the diff is `git diff <base>...HEAD` plus uncommitted changes; otherwise it is `git diff HEAD` (staged and unstaged). If the diff is empty, say so and stop.
2. **Engine.** Use the engine the user named. Otherwise pick the one that did not author the change: check `.codeome/bin/codeome-agent list` for recent write jobs. If Codex jobs wrote it, use Claude. If you or Claude subagents wrote it, use Codex. State the choice in one line.
3. **Brief.** Include the diff command, what the change is meant to do (the plan in `.codeome/plans/` if there is one), and how to run the tests.
4. **Dispatch** the `reviewer`, and also `security-reviewer` when it is installed and the diff touches auth, user input, SQL, file paths, external calls, crypto or secrets. Read-only reviews can run in parallel. Announce each handoff in one line.
   - Claude: Agent tool, `subagent_type: "reviewer"`.
   - Codex: Bash, `run_in_background: true`: `.codeome/bin/codeome-agent codex --role reviewer --title "Review: <topic>" <<'BRIEF' … BRIEF`
5. **Report.** For each BLOCKING/HIGH finding, check it against the code yourself before passing it on. Drop any finding you can't reproduce from the code, and say that you did. Present the findings ranked, with your own one-line assessment of each, and ask whether to fix them.
