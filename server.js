const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');

const execFileP = util.promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const YTDLP = './yt-dlp';
const JS_RUNTIME = 'node';
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/excache';
const MAX_CACHE_BYTES = 350 * 1024 * 1024;
const FILE_TTL_MS = 24 * 60 * 60 * 1000;

let FFMPEG_LOC = ''; // dir containing a usable ffmpeg binary, if one was found

fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ---------------------------------------------------------------------------
   yt-dlp + ffmpeg self-heal
   ------------------------------------------------------------------------- */
function runYt(args, timeoutMs) {
  return execFileP(YTDLP, args, {
    timeout: timeoutMs || 120000,
    maxBuffer: 64 * 1024 * 1024
  });
}

/* Locate a usable ffmpeg: PATH first, then Playwright's bundled copy. */
async function locateFfmpeg() {
  try {
    await execFileP('ffmpeg', ['-version'], { timeout: 5000 });
    return '';
  } catch (_) {}
  const roots = [path.join(process.env.HOME || '/', '.cache', 'ms-playwright')];
  if (fs.existsSync('/opt/render/.cache/ms-playwright')) roots.push('/opt/render/.cache/ms-playwright');
  for (const root of roots) {
    let sub = [];
    try { sub = fs.readdirSync(root); } catch (_) { continue; }
    for (const d of sub) {
      if (!/^ffmpeg-/.test(d)) continue;
      for (const b of [path.join(root, d, 'ffmpeg-linux'), path.join(root, d, 'ffmpeg')]) {
        if (!fs.existsSync(b)) continue;
        try { await execFileP(b, ['-version'], { timeout: 5000 }); return path.dirname(b); } catch (_) {}
      }
    }
  }
  return '';
}

async function ensureYtdlp() {
  try {
    const v = await execFileP(YTDLP, ['--version'], { timeout: 8000 });
    console.log('[extractor] yt-dlp ready (' + v.stdout.trim() + ')');
  } catch (_) {
    console.log('[extractor] downloading yt-dlp...');
    try {
      const tmp = YTDLP + '.tmp';
      const builtin = require('child_process');
      builtin.execFileSync('curl', ['-fsSL', 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', '-o', tmp], { stdio: 'inherit', timeout: 180000 });
      builtin.execFileSync('chmod', ['+x', tmp], { stdio: 'ignore' });
      fs.renameSync(tmp, YTDLP);
      console.log('[extractor] yt-dlp ready');
    } catch (e) {
      console.log('[extractor] yt-dlp download failed: ' + ((e && e.message) || e));
    }
  }
  FFMPEG_LOC = await locateFfmpeg();
  console.log('[extractor] ffmpeg location: ' + (FFMPEG_LOC || 'PATH'));
}

/* ---------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */
function youtubeVideoId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/|watch\/(?:v\/)?)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchOembed(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return {};
    const j = await r.json();
    return { title: j.title || '', author: j.author_name || '' };
  } catch (_) {
    return {};
  }
}

/* Order matters: the ANDROID-family clients are the most PO/bot-wall resistant
   (verified: they crack viral Shorts from residential IPs while WEB/ios cannot).
   Others fill in when one client is temporarily quota-limited. */
const CLIENTS = ['android', 'android_vr', 'ios', 'web_embedded', 'tv_embedded'];
const WALL_COOLDOWN_MS = 8000;
const extractCache = new Map();
const EXTRACT_CACHE_TTL = 4 * 60 * 1000;

function isBotWall(e) {
  const s = String(((e && e.stderr) || '') + ' ' + ((e && e.message) || ''));
  return /Sign in to confirm/i.test(s);
}

function errTail(e) {
  const s = String(((e && e.stderr) || '').toString() || (e && e.message) || e)
    .replace(/\s+/g, ' ').trim();
  return s ? (s.length > 160 ? s.slice(0, 160) + '…' : s) : '(no message)';
}

/* One full rotation pass over the client list, returning the first success. */
async function tryClients(url, clients) {
  for (const client of clients) {
    const args = ['--no-playlist', '--no-warnings', '--no-color', '--js-runtimes', JS_RUNTIME, '-j', url];
    if (client) args.unshift('--extractor-args', 'youtube:player_client=' + client);
    try {
      const r = await runYt(args, 60000);
      const j = JSON.parse(r.stdout);
      if (j && (j.formats || []).length) return { j };
      console.log('[extractor] client=' + (client || 'default') + ' -> empty formats');
      return { empty: true };
    } catch (e) {
      console.log('[extractor] client=' + (client || 'default') + ' -> ' + errTail(e));
      if (isBotWall(e)) return { wall: true };
      return { hard: e };
    }
  }
  return { none: true };
}

/* Fetch the video's full metadata + format table with a single yt-dlp call.
   YouTube rate-limits datacenter IPs ("Sign in to confirm you're not a bot") —
   for most videos its per-video PO proof, sometimes a short quota burst. We
   rotate clients (ANDROID first), cache successes briefly, and on a pure wall
   wait a few seconds then re-run the rotation once (quota walls often clear in
   seconds; persisting PO proofs are not surmountable from a free host — the
   caller gets an honest message). */
async function loadVideoInfo(url) {
  const hit = extractCache.get(url);
  if (hit && Date.now() - hit.t < EXTRACT_CACHE_TTL) return hit.j;

  const clients = [null].concat(CLIENTS);
  const passes = [[clients],
    null]; // second pass only if the first ended with a wall

  let firstHard = null;
  let lastErr = null;
  const seenWalls = [];
  for (let pass = 0; pass < passes.length; pass++) {
    const list = pass === 0 ? clients : passes[1];
    const out = await tryClients(url, list);
    if (out.j) {
      extractCache.set(url, { t: Date.now(), j: out.j });
      if (extractCache.size > 60) {
        for (const [k, v] of extractCache) if (Date.now() - v.t > EXTRACT_CACHE_TTL) extractCache.delete(k);
      }
      return out.j;
    }
    if (out.wall) seenWalls.push((list[0] === null ? 'default' : 'list') + ' pass=' + pass);
    if (out.hard && firstHard === null) firstHard = out.hard;
    lastErr = out.empty ? new Error('No playable formats in response.') : (out.hard || out.wall || lastErr);
    if (!out.wall && !out.none) break;
    if (pass === 0) {
      console.log('[extractor] wall detected, cooling down ' + WALL_COOLDOWN_MS + 'ms then retrying…');
      await new Promise((r) => setTimeout(r, WALL_COOLDOWN_MS));
      passes[1] = clients; // full re-rotation once
    }
  }
  if (seenWalls.length) {
    const e = new Error('YouTube is rate-limiting this server (bot check) — it can persist for viral Shorts. We rotated clients and retried automatically; come back in a minute and press Retry.');
    e.isWall = true;
    throw e;
  }
  throw firstHard || lastErr;
}

function isCombined(f) {
  return f && f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none';
}

/* Choose the best directly-downloadable combined MP4 for a max height, or null. */
function bestCombined(formats, maxH, minH) {
  const m = (formats || [])
    .filter((f) => isCombined(f) && f.ext === 'mp4' && /^(avc1)/.test(f.vcodec) &&
      f.height && f.height <= maxH && (!minH || f.height >= minH))
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  return m[0] || null;
}

function friendlyError(stderr) {
  const s = String(stderr || '');
  if (/Sign in to confirm/.test(s)) return 'YouTube asked for a login to view this video. Try a different video.';
  if (/Video unavailable/.test(s)) return 'This video is unavailable (deleted, private, or region-blocked).';
  if (/[Pp]rivate video/.test(s)) return 'This is a private video.';
  if (/is[-_ ]?live/i.test(s) && /live/i.test(s)) return 'Live streams are not supported yet.';
  if (/Requested format is not available|Unable to extract|No video formats/.test(s)) return 'No downloadable stream found for this video.';
  if (/This content is not available/.test(s)) return 'This video is not available.';
  return '';
}

/* ---------------------------------------------------------------------------
   In-flight mux dedupe
   ------------------------------------------------------------------------- */
let muxChain = Promise.resolve();
function runMuxExclusive(fn) {
  const r = muxChain.then(fn, fn);
  muxChain = r.then(() => {}, () => {});
  return r;
}
const muxInFlight = {};

function cacheFileName(name) {
  const m = String(name || '').match(/^([A-Za-z0-9_]{2,80})_(hd|sd)\.mp4$/);
  return m ? m[1] + '_' + m[2] + '.mp4' : null;
}

async function ensureMuxed(videoId, key, maxH) {
  const fname = videoId + '_' + key + '.mp4';
  const full = path.join(CACHE_DIR, fname);
  if (fs.existsSync(full)) return full;

  const base = 'https://www.youtube.com/watch?v=' + videoId;
  const args = [
    '--no-playlist', '--no-warnings', '--no-color',
    '--js-runtimes', JS_RUNTIME,
    '-f', muxFormat(maxH),
    '--merge-output-format', 'mp4',
    '--no-overwrites',
    '-o', path.join(CACHE_DIR, videoId + '_' + key + '.%(ext)s'),
    base
  ];
  if (FFMPEG_LOC) args.unshift('--ffmpeg-location', FFMPEG_LOC);

  await runYt(args, 600000);
  if (!fs.existsSync(full)) {
    // yt-dlp may have produced another container
    const dir = fs.readdirSync(CACHE_DIR).filter((n) => n.startsWith(videoId + '_' + key + '.'));
    if (!dir.length) throw new Error('merge produced no file');
    const target = path.join(CACHE_DIR, fname);
    fs.renameSync(path.join(CACHE_DIR, dir[0]), target);
  }
  touchCache();
  return full;
}

function muxFormat(maxH) {
  const v = 'bestvideo[ext=mp4][vcodec^=avc1][height<=' + maxH + ']+bestaudio[ext=m4a]';
  const v2 = 'bestvideo[ext=mp4][height<=' + maxH + ']+bestaudio[ext=m4a]';
  const v3 = 'bestvideo[ext=mp4][height<=' + maxH + ']+bestaudio';
  const v4 = 'bestvideo[height<=' + maxH + ']+bestaudio/best';
  return v + '/' + v2 + '/' + v3 + '/' + v4;
}

function touchCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).map((n) => ({ n, s: fs.statSync(path.join(CACHE_DIR, n)) }))
      .filter((x) => x.s.isFile());
    const total = files.reduce((a, x) => a + x.s.size, 0);
    if (total <= MAX_CACHE_BYTES) {
      for (const x of files) if (Date.now() - x.s.mtimeMs > FILE_TTL_MS) fs.unlinkSync(path.join(CACHE_DIR, x.n));
      return;
    }
    files.sort((a, b) => a.s.mtimeMs - b.s.mtimeMs);
    let acc = total;
    for (const x of files) {
      if (acc <= MAX_CACHE_BYTES) break;
      try { fs.unlinkSync(path.join(CACHE_DIR, x.n)); acc -= x.s.size; } catch (_) {}
    }
  } catch (_) {}
}

/* ---------------------------------------------------------------------------
   Routes
   ------------------------------------------------------------------------- */
app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'YouTube extractor backend (yt-dlp)' });
});

app.get('/api/extract', async (req, res) => {
  const url = (req.query.url || '').trim();
  const ytId = youtubeVideoId(url);
  if (!ytId) return res.status(400).json({ error: 'Enter a valid YouTube link.' });

  try {
    const info = await loadVideoInfo(url);
    if (info && info.is_live) return res.status(422).json({ error: 'Live streams are not supported yet.' });

    const formats = (info && info.formats) || [];
    const front = 'https://' + req.get('host');

    const variants = [];

    // HD: a real >=480p combined MP4 if available, otherwise lazy HD merge (720p).
    const hd = bestCombined(formats, 720, 480);
    if (hd) {
      variants.push({ key: 'hd', ext: 'mp4', url: hd.url, size: hd.filesize || 0 });
    } else {
      variants.push({ key: 'hd', ext: 'mp4', url: front + '/api/file/' + ytId + '_hd.mp4' });
    }

    // SD: direct combined MP4 <=480p if available, otherwise lazy SD merge (480p).
    const sd = bestCombined(formats, 480) || bestCombined(formats, 720, 360);
    if (sd) {
      variants.push({ key: 'sd', ext: 'mp4', url: sd.url, size: sd.filesize || 0 });
    } else {
      variants.push({ key: 'sd', ext: 'mp4', url: front + '/api/file/' + ytId + '_sd.mp4' });
    }

    let meta = { title: '', author: '' };
    if (!info || !info.title) {
      try { meta = await fetchOembed(url); } catch (_) {}
    }
    res.json({
      platform: 'youtube',
      title: (info && info.title) || meta.title || 'YouTube video',
      author: (info && (info.channel || info.uploader)) || meta.author || '',
      thumbnail: 'https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg',
      duration: (info && info.duration) || 0,
      variants
    });
  } catch (e) {
    console.log('[extractor] extract error: ' + ((e && e.message) || e));
    const detail = ((e && e.stderr) || '').toString();
    const msg = e.isWall ? e.message : (friendlyError(detail) || friendlyError((e && e.message) || ''));
    res.status(422).json({ error: msg || 'Could not resolve this video. It may be unavailable or YouTube is throttling requests. Try again in a minute.' });
  }
});

/* Lazily produce + stream a cached merged file (HD mostly). */
app.all('/api/file/*', async (req, res) => {
  const name = cacheFileName(req.params[0]);
  const ok = name;
  if (!ok) return res.status(404).json({ error: 'unknown file' });

  const { videoId, key } = (() => { const p = name.split('_'); return { videoId: p[0], key: p[1].replace('.mp4', '') }; })();
  const maxH = key === 'hd' ? 720 : 480;
  const full = path.join(CACHE_DIR, name);

  try {
    if (!fs.existsSync(full)) {
      if (muxInFlight[name]) {
        await muxInFlight[name];
      } else {
        const p = runMuxExclusive(() => ensureMuxed(videoId, key, maxH));
        muxInFlight[name] = p;
        try { await p; } finally { delete muxInFlight[name]; }
      }
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(full);
  } catch (e) {
    console.log('[extractor] mux error: ' + ((e && e.message) || e));
    res.status(500).json({ error: 'HD merge failed: ' + (((e && e.message) || e).toString().slice(0, 140)) });
  }
});

app.get('/api/probe-ytdlp', async (req, res) => {
  const url = req.query.url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const full = req.query.full === '1';
  const client = (req.query.client || '').trim(); // optional: force a specific innerTube client
  const t0 = Date.now();
  try {
    const args = [
      '--no-playlist', '--no-warnings', '--no-color',
      '--js-runtimes', JS_RUNTIME,
      '--skip-download',
      '-g',
      '-f', 'best[height<=720]/best',
      url
    ];
    if (client) args.splice(args.indexOf('--skip-download'), 0, '--extractor-args', 'youtube:player_client=' + client);
    const r = await runYt(args, 90000);
    const urls = r.stdout.trim().split(/\r?\n/).filter(Boolean);
    res.json({ ok: urls.length > 0, count: urls.length, ms: Date.now() - t0, client: client || 'default', urls: urls.slice(0, 4).map((u) => (full ? u : u.slice(0, 110))) });
  } catch (e) {
    res.status(500).json({ ok: false, ms: Date.now() - t0, client: client || 'default', error: String(((e && e.stderr) || '').toString() || (e && e.message) || e).slice(0, 500) });
  }
});

/* ---------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
async function main() {
  await ensureYtdlp().catch(() => {});
  touchCache();
  setInterval(touchCache, 30 * 60 * 1000);
  app.listen(PORT, () => {
    console.log('extractor running on ' + PORT);
  });
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('Fatal boot error:', e.message);
    process.exit(1);
  });
} else {
  module.exports = app;
}