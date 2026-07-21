#!/usr/bin/env node
/**
 * export-animations.mjs
 * -----------------------------------------------------------------------------
 * Records the site's live SVG/CSS "photo animations" from a real browser and
 * writes them out as GIF and MP4 files you can drop straight into a slide deck
 * (PowerPoint, Keynote, Google Slides all embed both).
 *
 * The animations on the site aren't image files — they're SVG + CSS running in
 * the browser — so there's nothing to "download". This tool renders the page
 * headlessly, captures one clean loop of each animation frame-by-frame, and
 * stitches the frames into looping video/GIF with ffmpeg.
 *
 * Usage:
 *   node tools/export-animations.mjs                 # export everything
 *   node tools/export-animations.mjs neuron feram    # only named targets
 *   FPS=30 SCALE=2 node tools/export-animations.mjs  # tweak quality
 *
 * Output goes to  exports/  in the repo root.
 *
 * Requirements (already present in this environment):
 *   - playwright (npm)         -> headless Chromium
 *   - imageio-ffmpeg (pip)     -> full ffmpeg with libx264 + gif
 * -----------------------------------------------------------------------------
 */

import { chromium } from 'playwright';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'exports');
const TMP_DIR = path.join(OUT_DIR, '.frames');

// --- Tunables (override via env) --------------------------------------------
const FPS = Number(process.env.FPS || 25);          // capture + MP4 frame rate
const GIF_FPS = Number(process.env.GIF_FPS || 15);  // GIFs sampled down (keeps size sane)
const SCALE = Number(process.env.SCALE || 2);       // default device pixel ratio (crispness)
const GIF_WIDTH = Number(process.env.GIF_WIDTH || 800); // px; GIFs get big, so cap width

// --- What to capture ---------------------------------------------------------
// `period` is the length of ONE animation loop in seconds, so the exported clip
// loops seamlessly. Values match the durations in css/styles.css & index.html.
// `scale` overrides the global DPR per target — the hero's heavy SVG blur/glow
// filters crash the sandbox's software GPU at 2x, so it renders at 1x.
const TARGETS = [
  { name: 'neuron', selector: '.pillar-card-v4:nth-of-type(1) .pillar-photo', period: 3.2,
    label: 'Neuromorphic — sparse spikes converge on the core' },
  { name: 'feram', selector: '.pillar-card-v4:nth-of-type(2) .pillar-photo', period: 5.0,
    label: 'FeRAM — non-volatile memory scan' },
  { name: 'imc', selector: '.pillar-card-v4:nth-of-type(3) .pillar-photo', period: 4.0,
    label: 'In-memory compute — crossbar dataflow' },
  // Hero is a full photo with a large moving glow, so its GIF is inherently
  // heavy — render a smaller/slower GIF (the MP4 stays full quality).
  { name: 'hero-chip', selector: '.hero-visual', period: 7.0, scale: 1,
    gifWidth: 520, gifFps: 12, label: 'Hero chip — float + glow + scan' },
  // Transparent variant: the chip .webp already has an alpha channel, so with the
  // page backgrounds forced transparent we can export the chip + glow with NO dark
  // box. MP4/H.264 can't hold alpha, so this emits GIF + APNG + alpha-WebM instead.
  { name: 'hero-chip-transparent', selector: '.hero-visual', period: 7.0, scale: 1,
    transparent: true, gifWidth: 480, gifFps: 12, label: 'Hero chip — transparent background' },
  { name: 'deployment-cycle', selector: '.cycle', period: 6.0,
    label: 'Deployment cycle' },
];

// --- Locate the full ffmpeg (from imageio-ffmpeg) ----------------------------
function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    const p = execFileSync('python3', ['-c',
      'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  return 'ffmpeg'; // hope it's on PATH
}
const FFMPEG = findFfmpeg();

function ff(args) {
  const r = spawnSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed (${args.join(' ')}):\n${r.stderr?.toString() || ''}`);
  }
}

// --- Tiny static file server so the page's lazy webp images actually load ----
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const file = path.join(ROOT, path.normalize(rel));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      const stream = fs.createReadStream(file);
      // The browser aborts in-flight requests (e.g. when it navigates or is torn
      // down); swallow the resulting stream/socket errors so they don't bubble up
      // as an uncaughtException and take the whole run down.
      stream.on('error', () => { try { res.destroy(); } catch {} });
      res.on('error', () => { try { stream.destroy(); } catch {} });
      stream.pipe(res);
    });
    server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function captureTarget(browser, t, baseURL) {
  const frameCount = Math.max(1, Math.round(t.period * FPS));
  const dir = path.join(TMP_DIR, t.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Fresh context + page per target: isolates renderer memory / scroll state and
  // lets each target pick its own DPR (`scale`).
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: t.scale || SCALE,
    reducedMotion: 'no-preference', // ensure animations actually run
  });
  const page = await context.newPage();
  // Block off-origin requests (Google Fonts) — the sandbox proxy resets them,
  // which otherwise stalls load for ~13s per page. System-font fallback is fine.
  await page.route('**/*', (route) => {
    const u = route.request().url();
    return (u.startsWith(baseURL) || u.startsWith('data:')) ? route.continue() : route.abort();
  });
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  const el = page.locator(t.selector).first();
  await el.scrollIntoViewIfNeeded();
  await el.waitFor({ state: 'visible' });
  // Let this target's lazy image load and the section reveal-animation settle.
  // (We deliberately do NOT force-decode every image on the page — decoding the
  // large hero/stack webps at high DPR at once can OOM and crash the renderer.)
  await page.waitForTimeout(1200);

  // Transparent capture: strip every opaque background so the screenshot's alpha
  // shows through (the chip .webp already has its own alpha; the glow is CSS).
  if (t.transparent) {
    await page.addStyleTag({ content:
      'html,body,section,.hero,.hero-visual,.chip-photo{background:transparent !important;}' +
      '.page-texture{display:none !important;}' });
    await page.waitForTimeout(200);
  }

  const box = await el.boundingBox();
  if (!box) throw new Error(`could not measure ${t.name} (${t.selector})`);

  // Deterministic capture: a screenshot takes far longer than one frame's worth
  // of wall-clock time, so we can't sample a live animation in real time. Instead
  // we PAUSE every animation inside the element and scrub its clock to an exact
  // instant before each grab. Covers both SMIL (<animate>, setCurrentTime on the
  // SVG root) and CSS keyframe animations (Web Animations API currentTime).
  await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    root.querySelectorAll('svg').forEach(s => { try { s.pauseAnimations(); } catch {} });
    root.getAnimations({ subtree: true }).forEach(a => { try { a.pause(); } catch {} });
  }, t.selector);

  for (let i = 0; i < frameCount; i++) {
    const tSec = (i * t.period) / frameCount; // exact animation time for this frame
    await page.evaluate(({ sel, tSec }) => {
      const root = document.querySelector(sel);
      root.querySelectorAll('svg').forEach(s => { try { s.setCurrentTime(tSec); } catch {} });
      root.getAnimations({ subtree: true }).forEach(a => { try { a.currentTime = tSec * 1000; } catch {} });
    }, { sel: t.selector, tSec });
    await el.screenshot({ path: path.join(dir, `f${String(i).padStart(4, '0')}.png`),
      timeout: 20000, omitBackground: !!t.transparent });
  }
  await context.close();
  return { dir, frameCount };
}

function encode(name, dir, opts = {}) {
  const inPattern = path.join(dir, 'f%04d.png');
  const mp4 = path.join(OUT_DIR, `${name}.mp4`);
  const gif = path.join(OUT_DIR, `${name}.gif`);
  const palette = path.join(dir, 'palette.png');
  const gifFps = opts.gifFps || GIF_FPS;
  const gifWidth = opts.gifWidth || GIF_WIDTH;
  const sz = (p) => (fs.statSync(p).size / 1024).toFixed(0) + ' KB';

  if (opts.transparent) {
    // Alpha outputs — H.264/MP4 can't carry transparency.
    const webm = path.join(OUT_DIR, `${name}.webm`);
    const f = `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos`;
    // Transparent GIF — the only transparent animation PowerPoint plays. Binary
    // (1-bit) alpha via alpha_threshold, so the chip stays crisp; the soft glow
    // gets a harder edge. dither=none keeps the file small.
    ff(['-y', '-i', inPattern, '-vf', `${f},palettegen=reserve_transparent=1:stats_mode=diff`, palette]);
    ff(['-y', '-framerate', String(FPS), '-i', inPattern, '-i', palette,
      '-lavfi', `${f}[x];[x][1:v]paletteuse=alpha_threshold=128:dither=none`, '-loop', '0', gif]);
    // WebM VP9 with alpha — smooth 8-bit alpha, tiny file. Best quality, but for
    // Keynote / Google Slides / web (PowerPoint can't play WebM).
    ff(['-y', '-framerate', String(FPS), '-i', inPattern,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30',
      '-auto-alt-ref', '0', webm]);
    return { gif, webm, gifSize: sz(gif), webmSize: sz(webm) };
  }

  // MP4 (H.264) — best quality/size, ideal for PowerPoint/Keynote video embeds.
  ff(['-y', '-framerate', String(FPS), '-i', inPattern,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
    '-movflags', '+faststart', mp4]);

  // GIF — universal fallback (two-pass palette for clean colours). Sampled to
  // GIF_FPS and capped width so files stay presentation-friendly.
  const gifFilter = `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos`;
  ff(['-y', '-i', inPattern, '-vf', `${gifFilter},palettegen=stats_mode=diff`, palette]);
  ff(['-y', '-framerate', String(FPS), '-i', inPattern, '-i', palette,
    '-lavfi', `${gifFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0', gif]);

  return { mp4, gif, mp4Size: sz(mp4), gifSize: sz(gif) };
}

async function main() {
  const wanted = process.argv.slice(2);
  const targets = wanted.length
    ? TARGETS.filter(t => wanted.includes(t.name))
    : TARGETS;
  if (!targets.length) {
    console.error(`No matching targets. Available: ${TARGETS.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const server = await startServer();
  const { port } = server.address();
  const baseURL = `http://127.0.0.1:${port}/`;
  console.log(`Serving ${ROOT} at ${baseURL}`);
  console.log(`ffmpeg: ${FFMPEG}`);
  console.log(`fps=${FPS} gifFps=${GIF_FPS} scale=${SCALE} gifWidth=${GIF_WIDTH}\n`);

  let browser = await chromium.launch();

  for (const t of targets) {
    process.stdout.write(`• ${t.name} (${t.period}s loop) … `);
    try {
      // A heavy target can crash the whole browser; relaunch if it died.
      if (!browser.isConnected()) browser = await chromium.launch();
      const { dir, frameCount } = await captureTarget(browser, t, baseURL);
      const r = encode(t.name, dir, { gifFps: t.gifFps, gifWidth: t.gifWidth, transparent: t.transparent });
      const outs = t.transparent
        ? `${path.basename(r.gif)} (${r.gifSize}), ${path.basename(r.webm)} (${r.webmSize})`
        : `${path.basename(r.gif)} (${r.gifSize}), ${path.basename(r.mp4)} (${r.mp4Size})`;
      console.log(`${frameCount} frames → ${outs}`);
    } catch (err) {
      console.log(`FAILED: ${err.message.split('\n')[0]}`);
    }
  }

  if (browser.isConnected()) await browser.close();
  server.close();

  // Clean up frame scratch unless KEEP_FRAMES is set.
  if (!process.env.KEEP_FRAMES) fs.rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\nDone. Files are in ${path.relative(ROOT, OUT_DIR)}/`);
  process.exit(0); // reset external sockets can keep the loop alive; exit cleanly
}

main().catch(e => { console.error(e); process.exit(1); });
