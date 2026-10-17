#!/usr/bin/env bash
# Regenerate the documentation screenshots in docs/public/screens/ from the real app (macOS).
#
# Usage:  bash docs/scripts/capture.sh              # every screen and detail crop
#         bash docs/scripts/capture.sh chats plots  # only these (output names without extension, or scenario names)
#         bash docs/scripts/capture.sh --theme light [names]  # one theme only
#         bash docs/scripts/capture.sh --list       # print the output names
#
# Each shot runs test/shot.js in the background (SHOT_BG=1: no Dock icon, no focus, hidden window) in a
# throwaway profile, once per theme, and takes the picture through the DevTools protocol at 2x
# (1500x940 CSS px -> 3000x1880 px). Output: <name>.webp (dark) and <name>-light.webp (light). The app
# is pointed at a neutral copy of the repo under a fixed fake home, so no real path, name or e-mail
# address reaches a picture. The copy's kit.json is set to the current kit version (no update banner).
# PNG masters stay in a temporary folder and are encoded with cwebp (-near_lossless 60).
# Usage also: --theme dark|light for one theme only. Electron, cwebp (brew install webp) are required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$ROOT/docs/public/screens"
unset ELECTRON_RUN_AS_NODE
# A fixed, neutral location (not under the real home): paths in the pictures read /Users/Shared/example/projects/codeome.
WORK=/Users/Shared/example
MARK=.codeome-docs-capture
LOCK=$WORK.lock

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
  'settings-hpc|settings-hpc|SHOT_HOST=alex@myhpc|'
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
THEMES=(dark light)
if [ "${1:-}" = "--theme" ]; then
  case "${2:-}" in dark|light) THEMES=("$2") ;; *) echo "--theme needs dark or light" >&2; exit 2 ;; esac
  shift 2
fi
command -v cwebp >/dev/null || { echo "cwebp not found (brew install webp)" >&2; exit 2; }
WANT=("$@")
wanted() { [ ${#WANT[@]} -eq 0 ] && return 0; local n; for n in "${WANT[@]}"; do [ "$n" = "$1" ] || [ "$n" = "$2" ] && return 0; done; return 1; }
for n in ${WANT[@]+"${WANT[@]}"}; do names | grep -x "$n" >/dev/null || { echo "unknown shot: $n" >&2; exit 2; }; done

# --- neutral fixtures -------------------------------------------------------------------------------
# The fixed fake home can only belong to one capture run at a time.
if ! mkdir "$LOCK" 2>/dev/null; then
  owner=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    echo "capture already running (pid $owner; lock $LOCK)" >&2
    exit 3
  fi
  echo "removing stale capture lock: $LOCK" >&2
  rm -rf "$LOCK"
  mkdir "$LOCK" || { echo "could not acquire capture lock: $LOCK" >&2; exit 3; }
fi
echo "$$" > "$LOCK/pid"
SHOT_PID= TIMER_PID= STAGE_DIR= BACKUP_DIR=
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$TIMER_PID" ]; then pkill -P "$TIMER_PID" 2>/dev/null || true; kill "$TIMER_PID" 2>/dev/null || true; fi
  if [ -n "$SHOT_PID" ]; then pkill -P "$SHOT_PID" 2>/dev/null || true; kill "$SHOT_PID" 2>/dev/null || true; fi
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && [ ! -e "$DEST" ]; then
    mv "$BACKUP_DIR" "$DEST" || echo "restore screens from $BACKUP_DIR" >&2
  fi
  [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR"
  [ -n "${CAPTURE_KEEP:-}" ] || { [ ! -f "$WORK/$MARK" ] || rm -rf "$WORK"; }
  if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$$" ]; then rm -f "$LOCK/pid"; rmdir "$LOCK"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
# Only ever delete a folder this script made itself (it carries a marker file).
if [ -e "$WORK" ]; then
  [ -f "$WORK/$MARK" ] || { echo "$WORK exists and was not created by this script; move it away first." >&2; exit 3; }
  rm -rf "$WORK"
fi
mkdir -p "$WORK"; : > "$WORK/$MARK"
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
# No "kit update available" banner: the copy's installed kit version equals the current one.
node -e 'const fs=require("fs"),p=process.argv[1]+"/.codeome/kit.json",k=JSON.parse(fs.readFileSync(p,"utf8"));k.version=JSON.parse(fs.readFileSync(process.argv[1]+"/kit/manifest.json","utf8")).version;fs.writeFileSync(p,JSON.stringify(k,null,2)+"\n")' "$PROJ"
ln -s "$ROOT/node_modules" "$PROJ/node_modules"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
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
shoot() { # name scenario env clip theme
  local name=$1 scen=$2 envs=$3 clip=$4 theme=$5 dir="$WORK/.shots/out/$1-$5" kv source status=0
  local out=$name; [ "$theme" = light ] && out=$name-light
  mkdir -p "$dir" || return 1
  envs=${envs//@RMD@/$RMD}; envs=${envs//@STORAGE@/$STORAGE}; envs=${envs//@RPROJ@/$RPROJ}
  local -a ev=(SHOT_BG=1 "SHOT_THEME=$theme" "CODEOME_HOME=$dir/home" "PATH=$WORK/bin:$PATH" SHELL=/bin/sh)
  for kv in $envs; do ev+=("$kv"); done
  [ -n "$clip" ] && ev+=("SHOT_CLIP=$clip" "SHOT_CLIP_NAME=$name")
  env "${ev[@]}" "$ELECTRON" "$PROJ/test/shot.js" "$dir" "$scen" >"$dir/log" 2>&1 &
  SHOT_PID=$!
  ( sleep 120; kill "$SHOT_PID" 2>/dev/null ) >/dev/null 2>&1 & TIMER_PID=$!
  if wait "$SHOT_PID"; then :; else status=$?; fi
  if [ "$status" -ne 0 ]; then pkill -P "$SHOT_PID" 2>/dev/null || true; kill "$SHOT_PID" 2>/dev/null || true; fi
  SHOT_PID=
  pkill -P "$TIMER_PID" 2>/dev/null || true; kill "$TIMER_PID" 2>/dev/null || true
  wait "$TIMER_PID" 2>/dev/null || true; TIMER_PID=
  source="$dir/$scen.png"; [ -z "$clip" ] || source="$dir/$name.png"
  if [ "$status" -ne 0 ] || [ ! -s "$source" ] || ! cp "$source" "$WORK/.shots/raw/$out.png"; then
    echo "FAILED: $out (capture exit $status; see $dir/log)" >&2
    return 1
  fi
}

FAILED=() OUTPUTS=()
run_all() {
  local s t name scen envs clip out
  for s in "${SHOTS[@]}" ${DETAILS[@]+"${DETAILS[@]}"}; do
    IFS="|" read -r name scen envs clip <<<"$s"
    wanted "$name" "$scen" || continue
    for t in "${THEMES[@]}"; do
      echo "capturing $name ($scen, $t)"
      out=$name; [ "$t" != light ] || out=$name-light
      OUTPUTS+=("$out")
      shoot "$name" "$scen" "$envs" "$clip" "$t" || FAILED+=("$out")
    done
  done
}
run_all
if [ ${#FAILED[@]} -ne 0 ]; then
  echo "capture failed: ${FAILED[*]}" >&2
  exit 1
fi

# --- encode -------------------------------------------------------------------------------------------
mkdir -p "$WORK/.shots/webp"
for b in ${OUTPUTS[@]+"${OUTPUTS[@]}"}; do
  cwebp -near_lossless 60 -m 6 -quiet "$WORK/.shots/raw/$b.png" -o "$WORK/.shots/webp/$b.webp" || { echo "FAILED: encode $b" >&2; exit 1; }
  [ -s "$WORK/.shots/webp/$b.webp" ] || { echo "FAILED: encode $b" >&2; exit 1; }
done
# Prepare the complete replacement beside screens so the final rename stays on one filesystem.
STAGE_DIR=$(mktemp -d "$ROOT/docs/public/.screens-stage.XXXXXX")
[ ! -d "$DEST" ] || cp -a "$DEST/." "$STAGE_DIR/"
for b in ${OUTPUTS[@]+"${OUTPUTS[@]}"}; do
  mv "$WORK/.shots/webp/$b.webp" "$STAGE_DIR/$b.webp"
done
# Only a completed, unfiltered two-theme run replaces the legacy PNG set.
if [ ${#WANT[@]} -eq 0 ] && [ ${#THEMES[@]} -eq 2 ]; then rm -f "$STAGE_DIR"/*.png; fi
BACKUP_DIR="$STAGE_DIR.old"
if [ -d "$DEST" ]; then mv "$DEST" "$BACKUP_DIR"; fi
mv "$STAGE_DIR" "$DEST"
STAGE_DIR=
[ ! -d "$BACKUP_DIR" ] || rm -rf "$BACKUP_DIR"
BACKUP_DIR=
for b in ${OUTPUTS[@]+"${OUTPUTS[@]}"}; do
  echo "wrote docs/public/screens/$b.webp ($(( $(stat -f %z "$DEST/$b.webp") / 1024 )) KB)"
done
