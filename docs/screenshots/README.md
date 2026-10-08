# Screenshots and demo GIFs

The PNGs and `demo-*.gif` files here are captured from the real app by
[`scripts/readme-media.mjs`](../../scripts/readme-media.mjs), driving ReCut through Playwright with footage from two
Blender open movies.

## Credits

*Tears of Steel* and *Sintel* © Blender Foundation | [mango.blender.org](https://mango.blender.org) /
[durian.blender.org](https://durian.blender.org), licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Short excerpts (and their English subtitles) are used only
in these screenshots and demos; they are not shipped with ReCut. The Tears of Steel subtitles are the official English
ones; Blender publishes only translations for Sintel, so its English subtitles are a transcript made in CI by the
speech-to-text engine bundled with ReCut (whisper.cpp, `base.en`).

## Regenerate

On GitHub: run the **README media** workflow ([`.github/workflows/readme-media.yml`](../../.github/workflows/readme-media.yml))
from the Actions tab (it also runs on a push of the capture script or the workflow to `claude/readme-refresh`). It
downloads and caches the footage, the subtitles and the Whisper `base.en` model, runs the script and commits the
changed files in this folder back to the branch. The outputs are also kept as the run's `readme-media` artifact.

Locally (Linux, xvfb, FFmpeg on PATH):

```bash
npm ci && npm run build && npx playwright install ffmpeg
# footage folder: tos.mov + tos-en.srt (Tears of Steel), sintel.mkv + sintel-en.srt (Sintel), ggml-base.en.bin
# (the workflow shows where each comes from and how sintel-en.srt is made)
xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/readme-media.mjs --media <footage> --out docs/screenshots --no-build
# no footage: synthetic test media and a stand-in speech-to-text engine (for debugging the script)
xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/readme-media.mjs --synthetic --out /tmp/shots --no-build
```

`--only project,demo-ocr` captures a subset. Budgets: stills are 1600×900; each GIF is at most 960 px wide, 12 s and
3 MB; the script fails when the changed files in this folder add up to more than 20 MB.
