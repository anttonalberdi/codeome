# Secrets

Tokens for GitHub accounts, Zenodo and PyPI are stored encrypted with the macOS Keychain and never shown in the interface.

Settings → *Secrets* keeps access tokens, API keys and passwords of your own, encrypted the same way. Each is named as an environment variable, such as `GITHUB_TOKEN`, and can carry a note. A saved value is never shown again:

- *Copy* puts it on the clipboard and takes it off again after 30 seconds.
- *Terminals* sets it as an environment variable in terminals, tasks and the R console started on this Mac.
- *Agents* sets it in the agent chat and in agent sessions on this Mac, so the agent can read and use it.

Both switches are off for a new secret and apply to what starts from then on. The button beside them, *All projects* at first, limits the secret to the projects you tick: only their terminals and agent sessions get it.

::: warning
Secrets are never sent to the HPC.
:::
