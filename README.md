# OnAir

A local recording studio for talking-to-camera videos over a live browser tab. It composites your camera
(DSLR on a Cam Link, or any webcam) with a shared tab such as Voice World, mixes mic and tab audio, and
records the result to MP4. Everything runs in the browser and there is no backend.

## Run

```bash
npm install
npm run dev        # http://localhost:3094
```

Use desktop Chrome. Allow the camera and mic when asked.

Voice World runs separately: `cd ~/Programming/Workspace/conjure && npm run dev` (http://localhost:3091).

## Recording workflow

1. **Set up two windows.** Put Voice World in its own Chrome window and OnAir in another, side by side or on
   a second screen. Separate windows keep both rendering. Wear headphones so the genie doesn't hear itself.
2. **Pick sources.** Choose the Cam Link under Camera (it is auto-picked if its name contains "Cam Link" or
   "Elgato") and your mic. Leave "Echo cancel" off when you wear headphones, since it sounds better.
3. **Share the world.** Click **Share Voice World tab**, pick the Voice World tab, and turn on **Also share
   tab audio**. The line under the button should say "tab audio on". Check both meters move.
4. **Frame it.** Pick an output (16:9, 9:16 for LinkedIn vertical, 1:1, 4:5) and a layout. Use **World
   crop** to trim edges or the wrong aspect, and **Fit** if you want the whole tab letterboxed.
5. **Record.** Press **Space** or **R** (or the button). After a 3-2-1 countdown it records. Switch layouts
   live, and the camera eases into place over about 400 ms. Press Space/R again to stop. The file downloads
   as `onair-YYYY-MM-DD_HH-MM-SS.mp4`.

The talking points and voice commands on the right are for you only and never appear in the recording.
Click any item to edit it. Edits are saved in this browser.

## Hotkeys (when the OnAir window is focused)

| Key | Action |
|---|---|
| 1 to 6 | Corner PiP, Side by side, Stack (camera over world), Camera only, World only, Free |
| P | Cycle the PiP corner |
| Space / R | Start (with countdown) / stop recording; Esc cancels the countdown |
| M | Mirror the camera |
| L | "Kyle Johnson" name card |

In **Free** mode, drag the camera box on the preview to move it, and drag its corner to resize it.
Hold Shift to keep its shape.

## Output

- Chrome records `video/mp4;codecs=avc1.640028,mp4a.40.2` (H.264 High + AAC) at 12 Mbps video and
  192 kbps audio, 30 fps. Browsers without MP4 recording fall back to WebM (VP9/Opus).
- Camera is requested at 1920×1080, 30 fps. The output size is fixed while recording.

## Verify

```bash
npm run dev &
node scripts/verify.mjs verify-out --chrome   # fake camera/mic/tab; drops screenshots + a test recording
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
