# Documentation scripts

`capture.sh` regenerates the screenshots in `docs/public/screens/` from the real app (macOS, needs `npm install` at the repo root).
Run `bash docs/scripts/capture.sh` for everything, or `bash docs/scripts/capture.sh chats plots` for a subset (output names or scenario names; `--list` prints them).
Each shot runs `test/shot.js` in dark mode against a neutral copy of the repo under a temporary home, so no real path, name or address appears; the result is downscaled with `sips` and recompressed with `pngquant` when installed.
Full-window shots are listed in `capture.sh`; detail crops (`detail-*.png`) are in `details.txt` as `name|scenario|env|css selector` and use the `SHOT_CLIP` option of `test/shot.js`.
Look at every changed picture before committing it: the pictures are public.
