# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/anttonalberdi/codeome/security/advisories/new)
on this repository, and include the Codeome version, what you did, and what you saw.

You can expect an acknowledgement within a week. Fixes go into the next release, and the report is
credited there unless you prefer otherwise.

## Supported versions

Only the latest release is supported.

## What is in scope

Codeome is a Mac app that runs on your own machine and talks to servers you configure (an HPC over
SSH, SFTP storage, GitHub, Zenodo, PyPI, Claude and Codex). Reports are especially welcome about:

- credentials or tokens leaking into logs, files, the repository or another process;
- command or path injection through settings, file names, remote output or chat content;
- the renderer gaining access it should not have.

## Credentials

Codeome keeps passwords and tokens in the macOS Keychain. If you ever paste a token into an issue,
a chat or a commit, revoke it at its provider straight away: deleting the message does not undo the exposure.
