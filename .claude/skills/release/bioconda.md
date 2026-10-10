# Bioconda

## Does it belong here
- Bioconda takes bioinformatics software. General-purpose packages go to conda-forge: see [conda-forge.md](conda-forge.md).
- Every dependency must already be on conda-forge or Bioconda. A missing one needs its own recipe first.
- The source must be a stable release archive (PyPI sdist or a GitHub tag tarball) with a licence. Not a branch.
- Bioconductor packages are not submitted by hand: `bioconductor-<name>` recipes are generated and updated in bulk after each Bioconductor release.

## New recipe
1. Fork `bioconda/bioconda-recipes` and branch from an up-to-date `master`.
2. Create `recipes/<name>/meta.yaml`. Start from `grayskull pypi <name>` for Python packages, then correct it by hand.
3. The recipe needs:
   - `{% set version = "…" %}`, the source `url` and its `sha256` (`curl -sL <url> | shasum -a 256`).
   - `build: number: 0`. Pure Python: `noarch: python` and `script: {{ PYTHON }} -m pip install . --no-deps --no-build-isolation -vvv`.
   - `run_exports` with `{{ pin_subpackage(name, max_pin="x") }}` (`"x.x"` while the version is 0.x). The linter requires it.
   - `requirements` split into `host` and `run`, with the same lower bounds as the package declares.
   - `test`: `imports` and a `commands` entry per executable (`<tool> --help`).
   - `about`: `home`, SPDX `license`, `license_file`, `summary`.
   - `extra: recipe-maintainers` with the GitHub handles that agreed to maintain it, and `identifiers` (DOI, bio.tools) when they exist.
4. Compiled code needs a `build.sh` and the `{{ compiler('c') }}` style build requirements.

## Check
- `bioconda-utils lint --packages <name>`.
- `bioconda-utils build --docker --mulled-test --packages <name>` when Docker is available. Otherwise `conda build recipes/<name>` and say in the report that the container test did not run.
- Install the built package into a fresh environment and run the tool.

## Submit
- Open a pull request from the fork to `bioconda/bioconda-recipes`, following its template. One recipe per pull request.
- CI lints and builds it. Fix failures by pushing to the same branch.
- When CI is green, comment `@BiocondaBot please add label` to ask for review. A Bioconda member merges it. The package appears on the channel shortly after the merge.

## New versions
- Nothing to do for a plain version bump: the autobump bot opens the pull request after the upstream release and pings the recipe maintainers.
- If dependencies, entry points or the build changed, edit the recipe yourself: new version and `sha256`, build number back to 0.
- To rebuild the same version (fixed dependency, changed recipe), raise the build number by one.

## Needs the user
- Approval to open the pull request: it is public and under their GitHub name.
- Their GitHub handle under `recipe-maintainers`, and answers to reviewers.
- A tagged upstream release to point the recipe at.
