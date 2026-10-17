# Contributing

Thanks for your interest in Codeome. Issues and pull requests are welcome.

## Set up

```sh
npm install
npm start      # run the app
npm test       # the test suite (Node 20 or newer)
```

Please run `npm test` before opening a pull request. CI runs it on Node 20 and 24.

## Documentation

The documentation site lives in `docs/` (VitePress) and is published to GitHub Pages when `main` changes.

```sh
cd docs
npm install
npm run docs:dev      # live preview
npm run docs:build    # the same build CI runs
```

When a change alters what users see, update the matching page in `docs/` in the same pull request.

## Keep personal data out

Codeome is built from real working sessions, so it is easy to commit something private by accident.
Before you commit:

- **No credentials.** Never commit tokens, passwords, keys or `.env` files. Report a leaked secret as described in [SECURITY.md](SECURITY.md).
- **Neutral examples.** In tests, fixtures, screenshots and placeholders use generic values such as
  `you@example.org`, `login.cluster.example.org`, `/home/user/project` and `abc123`, never real
  hosts, usernames, institutions, project names or email addresses.
- **No recorded sessions.** Do not commit transcripts or logs from real Claude, Codex or SSH sessions.
  Write a small synthetic fixture instead (see `test/fixtures/`).
- **Check your git identity.** Commits are public. Use a `users.noreply.github.com` address if you do
  not want your own email shown.

## Pull requests

- Keep a change focused, and add or update tests for behaviour you change.
- Match the style of the surrounding code, including its comments.
- Describe what changed and why in the pull request. A line in `CHANGELOG.md` is appreciated for user-visible changes.

By contributing you agree that your contribution is released under the project's [MIT license](LICENSE).
