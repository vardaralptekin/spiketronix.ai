# Exporting the site animations as GIF / MP4

The animated graphics on the site (the neuromorphic chip, the FeRAM scan, the
in-memory-compute crossbar, the hero chip, and the deployment cycle) are **live
SVG + CSS animations** running in the browser — there's no image file to
download. `export-animations.mjs` renders the page in a headless browser,
records one clean loop of each animation frame-by-frame, and writes out a **GIF**
and an **MP4** you can drop straight into a slide deck.

PowerPoint, Keynote and Google Slides all embed both formats. **Use the `.mp4`
where you can** — it's far smaller and sharper than the GIF; the GIF is a
universal fallback for places that only accept images.

## Output

Files land in [`../exports/`](../exports):

| File | Animation |
|------|-----------|
| `neuron.*`           | Neuromorphic — sparse spikes converge on the core |
| `feram.*`            | Non-volatile FeRAM — memory scan |
| `imc.*`              | In-memory compute — crossbar dataflow |
| `hero-chip.*`        | Hero chip — float + glow + scan |
| `deployment-cycle.*` | Deployment lifecycle |

Each name has a `.gif` and an `.mp4`. Every clip is exactly one animation loop,
so it repeats seamlessly.

## Running it

```bash
# One-time setup (already present in the Claude Code web environment):
#   - Node + Playwright (headless Chromium)
#   - a full ffmpeg, e.g.  pip install imageio-ffmpeg
# Playwright needs to resolve locally; if it isn't installed in the repo:
#   GR=$(npm root -g); mkdir -p node_modules
#   ln -s "$GR/playwright" node_modules/playwright
#   ln -s "$GR/playwright-core" node_modules/playwright-core

node tools/export-animations.mjs                 # export everything
node tools/export-animations.mjs neuron feram    # only named targets
```

## Tuning (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `FPS`       | `25`  | Capture + MP4 frame rate |
| `GIF_FPS`   | `15`  | GIF frame rate (lower = smaller files) |
| `SCALE`     | `2`   | Device pixel ratio — higher = crisper, bigger |
| `GIF_WIDTH` | `800` | Max GIF width in px |
| `KEEP_FRAMES` | –   | Keep the intermediate PNG frames in `exports/.frames/` |
| `FFMPEG`    | auto  | Path to an ffmpeg binary (auto-detected from imageio-ffmpeg) |

Example: `FPS=30 GIF_WIDTH=1000 node tools/export-animations.mjs neuron`

## How it works

A screenshot takes far longer than a single frame's worth of real time, so the
tool can't sample a live animation in real time. Instead it **pauses** every
animation inside the target element and **scrubs the clock** to an exact instant
before each grab — covering both SMIL (`<animate>`, `setCurrentTime`) and CSS
keyframes (Web Animations API `currentTime`). ffmpeg then assembles the frames
into an H.264 MP4 and a palette-optimised GIF.

## Adding or changing what gets captured

Edit the `TARGETS` array in `export-animations.mjs`. Each entry is:

```js
{ name: 'my-clip', selector: '.some-container', period: 4.0,
  scale: 1, gifWidth: 520, gifFps: 12, label: 'Description' }
```

- `selector` — a **stationary** element that contains the animation. If the
  element itself moves (a CSS transform on the element), capture its stationary
  parent instead, or the screenshotter will wait forever for it to hold still.
- `period` — one loop length in seconds (match the CSS/SMIL `dur`) for a seamless
  loop.
- `scale`, `gifWidth`, `gifFps` — optional per-target overrides. The hero uses
  `scale: 1` because its heavy SVG blur/glow filters crash the sandbox's
  software GPU at 2×.
