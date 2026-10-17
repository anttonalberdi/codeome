#!/usr/bin/env bash
# Regenerate the documentation screenshots in docs/public/screens/ from the real app (macOS).
#
# Usage:  bash docs/scripts/capture.sh              # every screen and detail crop
#         bash docs/scripts/capture.sh chats plots  # only these (output names without .png, or scenario names)
#         bash docs/scripts/capture.sh --list       # print the output names
#
# Each shot runs test/shot.js (dark theme, made-up data) in a throwaway profile. The app is pointed at a
# neutral copy of the repo under a temporary HOME (~/projects/codeome), so no real path, name or
# e-mail address reaches a picture. Captures are downscaled to at most 1800 px wide with sips and
# recompressed with pngquant when it is installed. Electron must be installed (npm install).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$ROOT/docs/public/screens"
unset ELECTRON_RUN_AS_NODE
# A fixed, neutral location (not under the real home): paths in the pictures read /Users/Shared/example/projects/codeome.
WORK=/Users/Shared/example
MARK=.codeome-docs-capture

# name|scenario|extra env (space separated KEY=value)|clip selector (empty for the whole window)
SHOTS=(
  'agent-chat|chats|SHOT_FIRST=1 SHOT_SIDE=520|'
  'chat-history|chats|SHOT_HISTORY=1|'
  'home-hero|projects||'
  'projects-groups|groups||'
  'project-links|groups|SHOT_LINKS=1|'
  'usage-popover|projects|SHOT_POPOVER=1|'
  'editor|editor||'
  'rmd|rmd|SHOT_RMD=@RMD@|'
  'plots|plots||'
  'chat-usage|stats|SHOT_POPOVER=1|'
  'forum|forum||'
  'ideas|ideas||'
  'personas|personas||'
  'settings-agents|settings-agents||'
  'settings-skills|settings-skills||'
  'settings-hpc|settings-hpc|SHOT_HOST=you@login.cluster.example.org|'
  'vpn|vpn||'
  'files|files|SHOT_STORAGE=@STORAGE@|'
  'transfer|transfer|SHOT_STORAGE=@STORAGE@|'
  'slurm|slurm|SHOT_NOJOB=1|'
  'git|git||'
  'git-account|git-account||'
  'packages|packages|SHOT_PROJECT=@RPROJ@ SHOT_RFILTER=ggplot|'
  'secrets|settings-secrets||'
  'settings|settings|SHOT_SECTION=git|'
  'settings-accounts|settings-accounts||'
  'overview|overview||'
)

# Detail crops live in details.txt next to this script: name|scenario|env|css selector, one per line.
DETAILS=()
# shellcheck disable=SC1091
[ -f "$(dirname "${BASH_SOURCE[0]}")/details.txt" ] && while IFS= read -r l; do [ -n "$l" ] && DETAILS+=("$l"); done < "$(dirname "${BASH_SOURCE[0]}")/details.txt"

names() { local s; for s in "${SHOTS[@]}" ${DETAILS[@]+"${DETAILS[@]}"}; do echo "${s%%|*}"; echo "$s" | cut -d'|' -f2; done; }
if [ "${1:-}" = "--list" ]; then names; exit 0; fi
WANT=("$@")
wanted() { [ ${#WANT[@]} -eq 0 ] && return 0; local n; for n in "${WANT[@]}"; do [ "$n" = "$1" ] || [ "$n" = "$2" ] && return 0; done; return 1; }
for n in ${WANT[@]+"${WANT[@]}"}; do names | grep -x "$n" >/dev/null || { echo "unknown shot: $n" >&2; exit 2; }; done

# --- neutral fixtures -------------------------------------------------------------------------------
# Only ever delete a folder this script made itself (it carries a marker file).
if [ -e "$WORK" ]; then
  [ -f "$WORK/$MARK" ] || { echo "$WORK exists and was not created by this script; move it away first." >&2; exit 3; }
  rm -rf "$WORK"
fi
mkdir -p "$WORK"; : > "$WORK/$MARK"
trap 'pkill -f "$WORK" 2>/dev/null || true; [ -n "${CAPTURE_KEEP:-}" ] || rm -rf "$WORK"' EXIT
export HOME="$WORK"
PROJ="$HOME/projects/codeome"
RPROJ="$HOME/projects/microbiome-analysis"
STORAGE="$WORK/storage"
RMD="$RPROJ/analysis.Rmd"
mkdir -p "$WORK/bin" "$PROJ" "$RPROJ" "$STORAGE/results" "$WORK/.shots/out" "$WORK/.shots/raw"
# Tracked files only (never untracked notes, .env files or other private leftovers), without docs/.
git -C "$ROOT" ls-files -z | while IFS= read -r -d '' f; do
  case $f in docs/*) continue ;; esac
  [ -e "$ROOT/$f" ] && printf '%s\0' "$f"
done | rsync -a --from0 --files-from=- "$ROOT/" "$PROJ/"
ln -s "$ROOT/node_modules" "$PROJ/node_modules"
git_() { git -C "$PROJ" -c user.name='Alex Example' -c user.email='alex@example.org' "$@"; }
git_ init -q -b main && git_ add -A && git_ commit -qm 'Add the transfer queue' --date='2 hours ago'
git_ remote add origin https://github.com/lab-research/codeome.git
printf '\n// tidy up\n' >> "$PROJ/main/slurm.js"; printf '\nNotes.\n' >> "$PROJ/README.md"; echo 'draft' > "$PROJ/notes.txt"
head -c 3000000 /dev/urandom > "$STORAGE/reads_R1.fastq.gz"
printf 'sample\tsite\nabc123\tA\n' > "$STORAGE/samples.tsv"; echo ok > "$STORAGE/results/summary.txt"
cat > "$RMD" <<'RMD'
---
title: "Gut microbiome overview"
output: html_document
---

```{r setup}
library(stats)
set.seed(1)
```

```{r diversity}
x <- data.frame(site = rep(c("A", "B"), each = 20), shannon = c(rnorm(20, 3.1, .3), rnorm(20, 3.6, .3)))
summary(x$shannon)
```

Shannon diversity is higher at site B.

```{r test}
t.test(shannon ~ site, data = x)
```
RMD
# A stand-in openconnect that just asks for a username, so the VPN sign-in prompt can be shown.
printf '#!/bin/sh\nprintf "Username:"\nsleep 600\n' > "$WORK/bin/openconnect"; chmod +x "$WORK/bin/openconnect"
printf 'Package: microbiomeanalysis\nTitle: Example\nVersion: 0.1.0\nImports: ggplot2\n' > "$RPROJ/DESCRIPTION"
printf 'library(ggplot2)\n' > "$RPROJ/plots.R"

# --- capture ------------------------------------------------------------------------------------------
shoot() { # name scenario env clip
  local name=$1 scen=$2 envs=$3 clip=$4 dir="$WORK/.shots/out/$1" kv
  mkdir -p "$dir"
  envs=${envs//@RMD@/$RMD}; envs=${envs//@STORAGE@/$STORAGE}; envs=${envs//@RPROJ@/$RPROJ}
  local -a ev=(SHOT_DARK=1 "CODEOME_HOME=$dir/home" "PATH=$WORK/bin:$PATH" SHELL=/bin/sh)
  for kv in $envs; do ev+=("$kv"); done
  [ -n "$clip" ] && ev+=("SHOT_CLIP=$clip" "SHOT_CLIP_NAME=$name")
  env "${ev[@]}" "$ROOT/node_modules/.bin/electron" "$PROJ/test/shot.js" "$dir" "$scen" >"$dir/log" 2>&1 &
  local pid=$!
  ( sleep 120; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 & local killer=$!
  wait "$pid" 2>/dev/null || true
  pkill -P "$killer" 2>/dev/null || true; kill "$killer" 2>/dev/null || true
  if [ -n "$clip" ]; then cp "$dir/$name.png" "$WORK/.shots/raw/$name.png" 2>/dev/null || echo "FAILED: $name (no clip)" >&2
  else cp "$dir/$scen.png" "$WORK/.shots/raw/$name.png" 2>/dev/null || echo "FAILED: $name" >&2; fi
}

run_all() {
  local s name scen envs clip
  for s in "${SHOTS[@]}" ${DETAILS[@]+"${DETAILS[@]}"}; do
    IFS="|" read -r name scen envs clip <<<"$s"
    wanted "$name" "$scen" || continue
    echo "capturing $name ($scen)"
    shoot "$name" "$scen" "$envs" "$clip"
  done
}
run_all

# --- optimise -----------------------------------------------------------------------------------------
mkdir -p "$DEST"
for f in "$WORK"/.shots/raw/*.png; do
  [ -e "$f" ] || continue
  w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')
  [ "$w" -gt 1800 ] && sips --resampleWidth 1800 "$f" >/dev/null
  if command -v pngquant >/dev/null; then pngquant --force --quality 70-95 --output "$f" -- "$f" || true; fi
  cp "$f" "$DEST/$(basename "$f")"
  echo "wrote docs/public/screens/$(basename "$f") ($(( $(stat -f %z "$f") / 1024 )) KB)"
done
