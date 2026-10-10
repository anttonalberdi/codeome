# conda-forge

## Does it belong here
- General-purpose packages, and dependencies that a Bioconda recipe is missing. Bioinformatics tools go to Bioconda: see [bioconda.md](bioconda.md).
- CRAN packages are named `r-<name>`. Python packages keep their PyPI name, lowercased.
- Check it is not there already: `conda search -c conda-forge <name>`, and search the `conda-forge/staged-recipes` pull requests.

## New recipe
1. Fork `conda-forge/staged-recipes` and branch from `main`.
2. Create `recipes/<name>/meta.yaml`. Start from `grayskull pypi <name>` for Python; use the conda-forge R skeleton helper for CRAN packages.
3. The recipe needs:
   - Source from the release archive (PyPI sdist, CRAN tarball, GitHub tag) with its `sha256`.
   - `build: number: 0`. Pure Python: `noarch: python`, with `python {{ python_min }}` in `host`, `python >={{ python_min }}` in `run`, and `python {{ python_min }}` in the test requirements.
   - Tests that run without the network: imports, `pip check`, `<tool> --help`.
   - `about`: `home`, SPDX `license`, and a `license_file` that is actually inside the archive.
   - `extra: recipe-maintainers`. Everyone listed must have agreed; they get commit rights to the feedstock.

## Check
- `conda build recipes/<name>` (or `python build-locally.py` in the fork, which needs Docker).
- Install the result into a fresh environment and run it.

## Submit
- Open a pull request to `conda-forge/staged-recipes` and fill in its checklist.
- The linter bot comments on the pull request. Fix what it reports.
- When CI is green, ask for review with a comment naming the right team, for example `@conda-forge/help-python, ready for review!` (`help-r` for R packages).
- After the merge, conda-forge creates `<name>-feedstock`. All later work happens there.

## New versions
- The autotick bot opens version pull requests on the feedstock. A maintainer checks the dependencies and merges.
- Manual changes go through a pull request from a fork of the feedstock, not a branch on it. Bump version and `sha256`, set the build number back to 0, then comment `@conda-forge-admin, please rerender`.

## Needs the user
- Approval to open the pull request: it is public and under their GitHub name.
- Agreement to be listed as maintainer, and merging the bot's pull requests afterwards.
