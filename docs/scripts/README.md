# Documentation scripts

`capture.sh` regenerates the screenshots in `docs/public/screens/` from the real app (macOS; needs `npm install` at the repo root and `cwebp`, `brew install webp`).
Run `bash docs/scripts/capture.sh` for everything, or `bash docs/scripts/capture.sh chats plots` for a subset (output names or scenario names; `--list` prints them). `--theme dark|light` captures one theme only.

- Every shot is taken twice: `<name>.webp` (dark) and `<name>-light.webp` (light). `test/shot.js` applies the theme (`SHOT_THEME`) centrally just before the capture, so Monaco, terminals and all panes follow it.
- Capture runs in the background (`SHOT_BG=1`): the app is an accessory app (no Dock icon, no focus), its window stays hidden, and the pictures come from the DevTools protocol (`Emulation.setDeviceMetricsOverride` with `deviceScaleFactor` 2, `Page.captureScreenshot`). Full screens are 3000x1880 px (1500x940 CSS px at 2x); detail crops are 2x their rectangle. You can keep working while it runs.
- The app runs against a neutral copy of the repo (tracked files only) under a fixed fake home, so no real path, name or address appears. The copy's `.codeome/kit.json` is set to the current kit version, so no "kit update available" banner shows, and update toasts are hidden.
- PNG masters stay in a temporary folder; the output is encoded with `cwebp -near_lossless 60 -m 6`. The whole folder is about 6 MB.
- A capture run holds an exclusive lock on the fixed fake home. Screenshots are published only after every requested capture and WebP encode succeeds. A full two-theme run removes legacy PNGs; a subset or one-theme run keeps them.
- Full-window shots are listed in `capture.sh`; detail crops (`detail-*`) are in `details.txt` as `name|scenario|env|css selector` and use the `SHOT_CLIP` option of `test/shot.js`.

Look at every changed picture (both themes) before committing: the pictures are public.
