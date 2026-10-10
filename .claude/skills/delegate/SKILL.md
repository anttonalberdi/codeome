---
name: delegate
description: Send one job to one specialist — a Claude subagent or a Codex job — without the full planning pipeline. Use when the user types /delegate or says "have Codex do X" / "ask the debugger to look at Y".
argument-hint: [role] [claude|codex] <job>
---

# Delegate one job

Request: $ARGUMENTS

1. Pick the role and engine. If the user named them, use those. Otherwise choose from [../orchestrate/routing.md](../orchestrate/routing.md) and state the choice in one line.
2. Write a self-contained brief: goal, context with `path:line`, constraints, acceptance check, out of scope. The specialist has none of your context.
3. Announce the handoff in one line, then dispatch:
   - Claude: Agent tool, `subagent_type: "<role>"`.
   - Codex: Bash with `run_in_background: true`:
     ```bash
     .codeome/bin/codeome-agent codex --role <role> --title "<short title>" <<'BRIEF'
     <brief>
     BRIEF
     ```
4. When it returns, say in one line what came of it. Run the acceptance check yourself before reporting success, and show the user the Status line and the key findings.

If the job is held back for usage (a Codex job exiting with code 75, or a denied Agent call that starts `Codeome: Claude account`), do not retry: offer the other engine, or tell the user which account is out and when it resets.

Do not commit the result. If the job changed files, tell the user, and offer `/cross-review` before committing.
