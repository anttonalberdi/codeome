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

## File secrets

Some credentials are a file, not a string: an Apple `.p8` signing key, for example, is a multi-line text file that a tool expects to read from a path. Add it as a file secret. Values that are short strings, such as the Key ID and Team ID that go with that key, stay in ordinary secrets.

To add one, set *Type* to *File* in the add form, then choose a text file or paste its content. The content must be UTF-8 text of at most 64 KB; binary files are refused. The file's extension (such as `.p8`) is kept, so tools that care about it get it. Nothing else of the original filename is used. *Save* stores the content encrypted, like any other secret, and it is never shown again.

The variable does not hold the content. It holds the path to a private file with the content, which you pass to the tool that needs it:

- On this Mac the file is in a private folder under Codeome's app data folder (mode `0700`, file mode `0600`). It is created when a terminal or agent first needs it, and removed when you quit Codeome, untick its scope or project, or remove the secret. If Codeome crashes, leftovers are swept at the next launch.
- On the HPC, *Sync to HPC* writes the file to `~/.codeome/secrets/files/<project>/` in your HPC home, and the project's env file exports the variable with that path. Unticking, removing and syncing again deletes files that no longer qualify.

*Replace…* keeps the type: a file secret takes a new file or pasted content, and empty content is refused (use remove to delete). To change a secret from text to file or back, remove it and add it again. *Copy* is not available for file secrets.

Agents see the name and are told it is a file path, and never to print it. That is advisory only: an agent can still read the file, so enable *Agents* for a file secret deliberately.

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
