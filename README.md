# OnAir

A local recording studio, vertical-first, for talking-to-camera videos over a live browser tab. It composites your camera
(DSLR on a Cam Link, or any webcam) with a shared tab such as Voice World, mixes mic and tab audio, and
records the result to MP4. Everything runs in the browser and there is no backend.

## Run

```bash
npm install
npm run dev        # http://localhost:3094
```

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
