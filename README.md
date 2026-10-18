# OnAir

A local recording studio, vertical-first, for talking-to-camera videos over a live browser tab. It composites your camera
(DSLR on a Cam Link, or any webcam) with a shared tab such as Voice World, mixes mic and tab audio, and
records the result to MP4. Recording runs entirely in the browser. **Finish** (captions + music) runs on a
small API inside the Vite dev server, using local ffmpeg and the AI Gateway.

## Run

```bash
npm install
cp .env.example .env   # AI_GATEWAY_API_KEY, only needed for Finish captions
npm run dev            # http://localhost:3094
```

Finish also needs `ffmpeg`/`ffprobe` on the PATH and Playwright's Chromium (`npx playwright install chromium`).

Use desktop Chrome. Allow the camera and mic when asked.

Voice World runs separately: `cd ~/Programming/Workspace/conjure && npm run dev` (http://localhost:3091).

## Recording workflow (9:16 reel by default)

1. **Open Voice World shaped for the reel.** Click **Open Voice World window**. It opens the URL in the box
   (default `http://localhost:3091`, remembered) as a popup whose shape matches the current layout's world
   box: 9:16 for Hook, Tall PiP, Bubble and World, and about 1:1 for Stack. Voice World's three.js camera
   renders that shape natively, so nothing gets cropped away. Reopen it after switching to or from Stack.
2. **Share it.** Click **Share Voice World tab**, pick the popup in the Chrome Tab list, and turn on **Also
   share tab audio**. The line under the button should say "tab audio on". Wear headphones.
3. **Camera and mic.** The Cam Link is auto-picked. If the DSLR is mounted on its side for true portrait,
   set **Rotate** so you're upright. Turn on **Ask for 4K** if the Cam Link gets 4K: the full-frame Hook
   from a landscape 1080p camera only uses a 608x1080 slice.
4. **Frame it.** Use **Face X / Face height** to keep your face framed. Each layout remembers its own. Or
   drag the camera on the preview. When the world is cropped, a minimap shows what's kept. Drag the world
   or use the arrow keys to pan it, or switch to **Fit, blurred fill**. Press G for the safe-zone guide
   (top 14%, bottom 20%, right button rail). It's only on the preview, never in the file.
5. **Record.** Press Space or R. There's a 3-2-1 countdown, then it records. Switch layouts live, and the
   camera eases into place over about 400 ms. Press Space/R again to stop. The file downloads as
   `onair-YYYY-MM-DD_HH-MM-SS.mp4`.

The talking points on the right include a shot list for each beat, e.g. `[1 Hook]`, `[3 Tall PiP -> 5 World]`.
They're yours only and never recorded. Click any item to edit it.

## Finish: captions + music

After a take stops, click **Finish this take** (under Output), or click **Finish a take** in the top bar and
pick any `onair-*.mp4` from ~/Downloads (or **Choose file...**). Then:

1. It transcribes with word timings (first run about 10 s for 2 minutes, about $0.006 per minute) and shows
   the caption cards. The preview draws them over the video with the same code the render uses.
2. Fix words by typing in a card. Click a card's time to jump to it.
3. Choose a caption style (Pop, Plate, Clean), a music mood (Wonder, Calm, Warm) and how far under the
   voice the music sits (default 24 dB, ducked further while anyone talks).
4. **Render**. The file lands next to the source as `<take>-final.mp4`, with `<take>-final.transcript.json`
   beside it. Click **Download** to get a copy.

Same pipeline from the terminal:

```bash
npm run finish -- ~/Downloads/onair-2026-10-18_15-40-51.mp4                # pop captions, wonder music, -24 dB
npm run finish -- take.mp4 --style clean --mood calm --music-db 28 --out x.mp4
npm run finish -- take.mp4 --no-music        # or --no-captions; --analyze prints the cards only
```

How it works (`finish/`):

- **Transcription** works like Camera Shy: `openai/whisper-1` through the AI Gateway, `timestampGranularities:
  ['word']`, `language: 'en'`, no prompt. The take goes up in about 15 s chunks cut in pauses. On a whole
  2-minute file, whisper drops "you know", "kind of" and "right?", so the captions stop matching the voice.
  Zero-length words get up to 280 ms. A word stretched across a detected pause is trimmed to the speech.
  Punctuation comes back from whisper's text. Common mis-hearings of Voice World, Claude, Kyle and Monument
  Labs are fixed.
- **Cards** use Camera Shy's cadence. A card breaks at 4 words (5 for Clean), 1.6 s, a 500 ms pause or a
  sentence end. It stays 250 ms past its last word, never past the next card. The spoken word lights up
  `#facc15`. Type is system-ui 800 at `min(h * 0.046, w * 0.066)`, centered, wrapped at 86% width.
- **Placement**: in Stack, the seam between the world and the camera is detected from the frames, and the
  cards sit just above it so they never cover your face. Otherwise the last line's baseline is at 76.5%
  height, which keeps it above the Reels bottom 20%.
- **Music** is synthesized in `finish/music.mjs`: a sine-partial pad and a sparse bell arpeggio, through a
  delay and reverb. No samples, so there's nothing to license. It's set relative to the measured voice
  loudness, `sidechaincompress`-ducked under speech, with a 2 s fade in and a 3 s fade out. The whole mix is
  then two-pass `loudnorm` to -14 LUFS / -1.5 dBTP.
- **Render**: each caption state becomes a transparent PNG drawn by headless Chromium with
  `finish/captions.js`. An ffconcat list on integer milliseconds goes to `overlay`, then libx264 High,
  30 fps CFR, AAC 192k / 48 kHz, `+faststart`. The Homebrew ffmpeg has no libass or drawtext, which is why
  the captions are images. Every step caches in `.finish/<take>-<hash>/`, so a rerun only re-encodes.

Verify the panel end to end (dev server running): `node scripts/verify-finish.mjs <short-take.mp4> verify-out/finish`.

## Layouts and hotkeys (when the OnAir window is focused)

| Key | 9:16, 4:5, 1:1 | 16:9 |
|---|---|---|
| 1 | Hook: full-frame camera | Corner PiP |
| 2 | Stack: world top (58%), camera below; split slider, S swaps | Side by side |
| 3 | Tall PiP: world full-bleed, 3:4 or 9:16 camera card, lower right above the caption zone, clear of the button rail | Stack |
| 4 | Bubble: circular camera | Camera |
| 5 | World, for the money shot | World |
| 6 | Free: drag the camera box, drag its corner to resize (Shift keeps its shape) | Free |

Other keys: P cycles the card corner, arrow keys pan the world (Shift pans further), M mirrors, L toggles
the "Kyle Johnson" name card, G toggles the guide, and Esc cancels the countdown.

## Output

- Chrome records `video/mp4;codecs=avc1.640028,mp4a.40.2` (H.264 High + AAC) at 12 Mbps video and
  192 kbps audio, 30 fps. Browsers without MP4 recording fall back to WebM (VP9/Opus).
- Camera is requested at 1920x1080 (or 3840x2160 with "Ask for 4K"), 30 fps. The output size is fixed while recording.

## Verify

```bash
npm run dev &
node scripts/verify.mjs verify-out --chrome   # fake camera/mic + synthetic world; screenshots + a 9:16 test recording
node scripts/verify.mjs verify-out --chrome --real-share   # same, through Chrome's real getDisplayMedia
```

## Known limits

- Finish captions everyone the mic and tab heard, so the genie's lines get captions too, and Voice World
  already shows them on screen. Delete those cards if you don't want them. Whisper can still tidy a filler
  word or two, and a rerun can differ slightly. Seam detection only knows Stack: in Tall PiP or Bubble,
  check the preview, because the card can overlap the camera card.

- Hotkeys only work while OnAir has focus. While you talk to Voice World, its window has focus, so
  switch layouts with a click on OnAir (or on a second screen) between beats.
- Rendering runs on a worker clock and reads frames through `MediaStreamTrackProcessor`, so it keeps
  going when the window is in the background. Chrome can still slow a minimized window, so keep OnAir
  visible somewhere and don't minimize it.
- The recording is variable-frame-rate MP4 from MediaRecorder. Most editors handle it. If one stutters,
  convert it first: `ffmpeg -i in.mp4 -r 30 -c:v libx264 -crf 18 -c:a copy out.mp4`.
- Changing the output size during a recording is disabled.
- Voice World adapts to the popup's shape (its renderer has a ResizeObserver that updates the camera
  aspect), but the vertical FOV is fixed at 65 degrees, so a 9:16 window sees only about 39 degrees side to side.
  A cheap fix in `conjure/app/world/renderer.ts` `resize()` would widen the FOV in portrait, e.g.
  `camera.fov = clamp(2*atan(tan(32.5deg) * 0.75 / aspect), 65, 90)`.
- Chrome can't resize the popup after it opens, so OnAir closes it and opens a new one. That ends the
  share, so share again.
