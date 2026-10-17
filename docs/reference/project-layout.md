# Project layout

A developer reference to how the Codeome source is organised.

```
main/          Electron main process
  main.js        window, menus, IPC handlers
  ssh.js         shared SSH connection (ControlMaster), remote files
  sftp.js        long-term storage over SFTP (e.g. ERDA): listing, files, transfers
  slurm.js       squeue / sacct / scancel / sbatch
  zenodo.js      Zenodo REST client
  github.js      GitHub accounts: token validation, per-command credentials for Git and gh, Keychain-encrypted
  config.js      settings + Keychain-encrypted tokens
  secrets.js     your own secrets: their names, and which processes get them as environment variables
  chat.js        the Agent chat's headless Claude Code sessions (stream-json), saved chats
  stats.js       each chat's token meter (context window, tokens a turn) and the statistics log
  kit.js         installs/updates the agent kit in a project
  jobs.js        reads agent job records from .codeome/jobs/
  usage.js       Claude/Codex accounts and usage limits; writes ~/.codeome/usage.json
  rtools.js      R plots (redraw, export) and R libraries; puts main/r/*.R in ~/.cache/codeome on each host
  r/             plots.R (sourced into R consoles), render.R (redraws a recorded plot), packages.R
  codeome-statusline   Claude Code status line that records rate limits
  preload.js     the bridge the interface is allowed to use
renderer/      Interface (plain JS, no build step)
  index.html, styles.css
  js/            one file per area: projects, usage, editor, rmd, terminals, files, transfer, slurm, git, publish, packages, plots, chat, agents, settings
                 (stack.js: the stacked sections of Files and Packages)
kit/           the agent kit: roles/ (one file per role), skills/, bin/codeome-agent, manifest.json;
               chat.md, the orchestrator instructions for the Agent chat
               personas/ (specialists offered in an empty chat; ship with the app, not installed into projects)
build/         the app icon: icon.icns for the packaged app, icon.png for the dock under npm start, and the SVGs they were drawn from
test/          parser tests (npm test) and a screenshot helper
               github.test.js (token validation and credentials), gitaccounts-ipc.test.js (account and identity IPC),
               config-secrets.test.js (tokens in the config file)
```

Working on Codeome itself: open this folder in Codeome and ask for the change in the Agent chat. `npm start` relaunches it.
