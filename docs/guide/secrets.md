# Secrets

Tokens for GitHub accounts, Zenodo and PyPI are stored encrypted with the macOS Keychain and never shown in the interface.

Settings → *Secrets* keeps access tokens, API keys and passwords of your own, encrypted the same way. Each is named as an environment variable, such as `GITHUB_TOKEN`, and can carry a note. A saved value is never shown again:

- *Copy* puts it on the clipboard and takes it off again after 30 seconds.
- *Terminals* sets it as an environment variable in terminals, tasks and the R console started on this Mac.
- *Agents* sets it in the agent chat and in agent sessions on this Mac, so the agent can read and use it.
- *HPC* allows it in the current project's private secrets file in your HPC home after syncing.

All three switches are off for a new secret. The button beside them, *All projects* at first, limits the secret to the projects you tick. Only those projects can use it in each enabled scope. Local terminals and agents started after a change get the new setting.

<Shot src="/screens/secrets.webp" alt="Settings Secrets page listing GITHUB_TOKEN, HF_TOKEN, ZENODO_COPY and LOST with Terminals and Agents checkboxes and Copy and Replace buttons" caption="Each secret has a note, scope switches, a project button, Copy, Replace… and delete. The HPC switch and Sync to HPC button are also available in Settings." width="1500" height="940" />

<Shot bare src="/screens/detail-secrets.webp" alt="Four secret rows: GITHUB_TOKEN on for terminals and agents in all projects, HF_TOKEN on for terminals only for the codeome project, ZENODO_COPY copy only and LOST with no value" caption="GITHUB_TOKEN is set for terminals and agents in all projects, HF_TOKEN only in terminals of codeome, and LOST has no value." width="898" height="247" />

## Using a secret

In a local terminal with *Terminals* enabled, refer to a secret as `$NAME`, for example `$GITHUB_TOKEN`. Use the variable in a command or script; avoid printing its value.

For the HPC, enable *HPC* for the secret, open the project, then select *Sync to HPC*. Settings shows the path and names synced. Codeome keeps a separate file for each project at `~/.codeome/secrets/<name>-<hash>.env` in your HPC home, never under `/projects`. The folder is mode `0700` and the file is mode `0600`. Codeome HPC terminals source the file automatically. In another HPC shell, use the exact path shown in Settings:

```sh
source "$HOME/.codeome/secrets/<name>-<hash>.env"
```

Then use `$NAME` as in a local terminal. An `sbatch` job submitted from a shell with the variable set inherits that environment. For an unattended job or a job launched outside a Codeome terminal, source the private file at the start of the job script, or arrange another secure way to provide the variable. If you rotate a secret, replace its value in Settings, sync again, restart shells and resubmit jobs that need the new value, and revoke the old credential.

::: warning
HPC secrets are opt-in. Their values are stored as plaintext in the private file in your HPC home. Never paste secret values into chat or commit them to a repository, job script or log. All projects share your one HPC account, so a process of yours in one project can read the secrets files of your other projects there: the per-project files limit what each shell loads by default, not what you can read. Do not enable *HPC* for a secret you would not want available to every job you run on the cluster.
:::
