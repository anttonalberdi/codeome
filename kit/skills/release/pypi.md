# PyPI

## Before building
- `pyproject.toml` declares name, version, description, readme, license, `requires-python`, dependencies, and project URLs.
- New project: check the name is free (`https://pypi.org/pypi/<name>/json` returns 404). Names are compared case-insensitively, with `-`, `_` and `.` treated as the same character.
- The version has never been uploaded. PyPI refuses a file name it has seen before, even after the release was deleted. A mistake costs a version number.

## Build and check
1. Remove `dist/`, then `python -m build` (sdist and wheel).
2. `twine check dist/*`.
3. List the contents: `tar tzf dist/*.tar.gz`, `unzip -l dist/*.whl`. Look for missing package data and for files that should not ship (tests data, notebooks, `.env`, large files).
4. Install the wheel into a fresh virtual environment. Import the package, run each console script with `--help`, and run the tests against the installed copy.

## TestPyPI first
- Upload to TestPyPI, then install from it: `pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ <name>==<version>`.
- TestPyPI also refuses reused file names. Use a `.devN` or `rcN` version for rehearsals.

## Publish
Prefer, in this order:
1. **Trusted publishing from GitHub Actions.** A workflow triggered by a published GitHub release builds and uploads with `pypa/gh-action-pypi-publish`, with `permissions: id-token: write` and no stored token. You can write the workflow; the project owner registers the publisher on pypi.org.
2. **Codeome's Publish view**, which holds the PyPI token in the Keychain and runs the upload. Tell the user the artefacts in `dist/` are ready.

Do not run `twine upload` with a token yourself.

## After
- Tag `v<version>` and create the GitHub release, if the brief says to.
- If a Bioconda or conda-forge recipe exists, its bot opens the version bump within about a day. Dependency changes need a manual edit there: say so in the report.

## Needs the user
- Registering the trusted publisher on pypi.org, or adding the token in Settings → Zenodo & PyPI.
- Approval for the upload to PyPI itself. It is permanent.
