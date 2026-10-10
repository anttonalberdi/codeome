---
name: release
description: Playbooks for publishing a package to PyPI, Bioconda, conda-forge, CRAN or Bioconductor — what to check, what to submit, and which steps only the maintainer can do. Read it before planning or briefing a release to one of those registries.
user-invocable: false
---

# Release playbooks

One file per registry. Read only the one the task names:

| Registry | Playbook | Publishing ends with |
|---|---|---|
| PyPI | [pypi.md](pypi.md) | an upload that can never be replaced |
| Bioconda | [bioconda.md](bioconda.md) | a public pull request reviewed by Bioconda members |
| conda-forge | [conda-forge.md](conda-forge.md) | a public pull request reviewed by conda-forge members |
| CRAN | [cran.md](cran.md) | a web form, then a confirmation email to the maintainer |
| Bioconductor | [bioconductor.md](bioconductor.md) | a public issue, then weeks of review |

## Which registry

- Python package: PyPI first. Then Bioconda if it is bioinformatics software, conda-forge otherwise. Both build from the PyPI sdist.
- R package: CRAN, or Bioconductor if it builds on Bioconductor classes. Never both. The conda packages follow on their own (`r-<name>` on conda-forge, `bioconductor-<name>` on Bioconda).
- Command-line tool in another language: Bioconda or conda-forge, from a tagged GitHub release.

## For the orchestrator

- Route the work to the `release-manager` on Claude. Registries need the network, which Codex jobs do not have.
- Name the registry, the version and the playbook path in the brief. Say explicitly whether the job stops at "ready to submit" or may submit.
- Every playbook has a **Needs the user** section. Put those steps in front of the user at Gate 1, so they are not discovered half-way.
- Submitting is public and mostly irreversible. It needs its own approval, separate from approving the plan.

## Rules for every registry

- A release starts from a clean, committed tree and a version that has never been published.
- Prepare and check locally first. Report what was run and what could not be run on this machine.
- Never ask for a token in the chat and never write one to a file. PyPI and Zenodo tokens live in Codeome's Publish view. Pull requests go through the user's `gh` login.
- Stop at the first step in **Needs the user** and report, rather than waiting or working around it.
