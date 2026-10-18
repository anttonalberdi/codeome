# Project settings

Open Project settings with `⌘9`, the last item in the left rail. It sets rules for the agents in the open project: whether they may submit Slurm jobs, publish with git, change things on the HPC or write outside the project, and whether they must plan first. Each choice is saved as soon as you click it, and *Reset to defaults* at the bottom clears them all.

The rules are stored per project in Codeome's own config, keyed by the project folder. They are not written into the repository and are not committed, so they stay on this Mac and are not shared with collaborators.

## The switches

| Switch | Choices (default first) | What it does |
| --- | --- | --- |
| Slurm job submission | *Ask*, *Allow (best effort)*, *Never* | Agents running `sbatch`, `srun` or `salloc`, locally or over SSH. |
| Git publishing | *Ask*, *Never* | Agents running `git commit`, `git push` or `git tag`. |
| HPC access | *Full*, *Read-only* (advisory) | Read-only denies remote commands that change things: `rm`, `mv`, `cp`, write redirects, `scancel`, `sbatch`, `srun` and `salloc`. |
| Writes outside project | *Ask*, *Never* | Agent file edits (Write, Edit, notebook edits) outside the project folder. |
| Require a plan | *Off*, *On* (advisory) | Asks the agent to present a plan before changing files. |

*Ask* leaves things as they were: the agent follows the permission selector in the chat. *Never* denies the action, and the agent is told to prepare the work and tell you the exact command instead.

*Allow* for Slurm pre-approves submissions in Codeome, so you are not asked each time, and tells the agent that the project owner has authorised it. Claude's own safety checks may still refuse to submit. If that happens, submit the job yourself.

Switches marked *advisory* are weaker. *Require a plan* only adds a line to the agent's instructions. *HPC access* adds the same kind of instruction and also denies the commands listed above, but only the ones Codeome recognises.

## When changes take effect

- Permission checks (the *Never* denials and the Slurm *Allow* pre-approval) apply to chats that are already running, from their next request.
- The rule text given to the agent, and the matching deny and allow rules passed to the Claude CLI, are fixed when a chat starts. They apply to new chats only.

## Limits

Matching is heuristic and is not a security boundary. Codeome looks at the command the agent runs, including commands after `ssh`, in `bash -c` strings, in `$(...)` and in here-documents. It does not look inside scripts: a script that itself calls `sbatch` is not caught. Treat the switches as guard rails against an agent doing something you did not intend, not as protection against one that is trying to get round them.

Codeome checks a command when the agent asks permission to run it. In a chat running in a mode that never asks (Claude's bypass-permissions mode, or a Codex session whose sandbox never escalates), only the deny rules passed to the agent at start apply, and they match fewer spellings. A *Never* setting is therefore most reliable in the default, accept-edits and auto modes. The deny rules also stop `git tag` in any form, including `git tag -l`, in Claude chats while Git publishing is *Never*.

Jobs that agents start in Codex have no network or SSH access, so the Slurm switch matters mainly for Claude chats and for roles that run on Claude. See [Agent chat](/guide/agent-chat) and [The team](/guide/team).
