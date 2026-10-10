const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SITE = 'https://vidssave.com/youtube-video-downloader-8hs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------------------------------------------------------------------
   Chromium self-heal
   If the Playwright browser binary is missing (e.g. Render built with only
   `npm install`), download it on boot. Cached after first time.
   ------------------------------------------------------------------------- */
async function ensureChromium() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const b = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
      await b.close();
      console.log('[extractor] Chromium ready');
      return;
    } catch (e) {
      const msg = String(e.message || '');
      if ((attempt === 0 || attempt === 1) && (/Executable doesn't exist|Looks like Playwright was just installed|chromium_headless_shell/i.test(msg))) {
        console.log('[extractor] Chromium missing or mismatch \u2014 installing...');
        try { execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' }); } catch (_) { execSync('npx playwright install chromium', { stdio: 'inherit' }); }
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}

/* ---------------------------------------------------------------------------
   Persistent browser + request serialization.
   vidssave renders one result list at a time on a single page, so we run one
   extraction at a time and reuse a warm browser between requests.
   ------------------------------------------------------------------------- */
let browserInstance = null;
async function getBrowser() {
  if (browserInstance) {
    try { if (browserInstance.isConnected()) return browserInstance; } catch (_) {}
    browserInstance = null;
  }
  const b = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  b.on('disconnected', () => { if (browserInstance === b) browserInstance = null; });
  browserInstance = b;
  return b;
}

let chain = Promise.resolve();
function withLock(fn) {
  const result = chain.then(fn, fn);
  chain = result.then(() => {}, () => {});
  return result;
}

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

/* Collect the quality rows vidssave renders after parsing. Runs in-browser.
   Rows are <li> cards whose text looks like "MP4 720P 28.4 MB Fast Download".
   Nav items also say "Download" but never contain MP4/MP3, so they drop out. */
function collectRows() {
  const rows = [];
  const lis = Array.from(document.querySelectorAll('li'));
  for (const li of lis) {
    const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/Download/i.test(t) || !/MP4|MP3/i.test(t)) continue;
    // textContent has no separators between spans, e.g. "MP4240P7.46 MBFastDownload".
    // A lookbehind stops the greedy run from swallowing MP4/MP3's leading digit
    // (which would turn "4720P" into 4720 and get misclassified as HD).
    const qm = t.match(/(?<!MP)(\d+)\s*(P|KBPS)/i);
    rows.push({
      text: t,
      isAudio: /MP3/i.test(t),
      qualityNum: qm ? parseInt(qm[1], 10) || 0 : 0
    });
  }
  return rows;
}

/* Wait until the full quality list has rendered. Rows appear progressively
   (240P/1440P land first, then the rest), so poll for a stable set. */
async function waitForRows(page, minRows, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  let stableFor = 0;
  while (Date.now() < deadline) {
    rows = await page.evaluate(collectRows).catch(() => []);
    if (rows.length >= minRows) break;
    await sleep(2000);
  }
  // let any late rows paint, then take a final sample
  await sleep(1200);
  const final = await page.evaluate(collectRows).catch(() => rows);
  return final.length >= rows.length ? final : rows;
}

/* Resolve with the direct link produced when a row's Download control is
   clicked. Primary signal: the `media/download_redirect` response's Location
   header (302 -> down-de.vidssave.com/...). Backup: a real browser download
   event. Bound to the context so popups/secondary pages are caught too. */
async function captureLink(context, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); context.off('response', onResponse); context.off('download', onDownload); };
    const finish = (v) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v && v.url && /^https?:/i.test(v.url) ? { url: v.url, name: v.name || '' } : null);
    };
    const onResponse = (r) => {
      if (settled) return;
      const u = r.url();
      if (u.indexOf('contentsite_api/media/download_redirect') === -1) return;
      try {
        const loc = (r.headers()['location'] || '') || '';
        finish(loc ? { url: loc, name: '' } : null);
      } catch (_) {}
    };
    const onDownload = (d) => {
      if (settled) return;
      let url = '';
      try { url = d.url(); } catch (_) {}
      let name = '';
      try { name = d.suggestedFilename ? d.suggestedFilename() : ''; } catch (_) {}
      try { d.cancel && d.cancel(); } catch (_) {}
      if (/^blob:/i.test(url)) return;
      finish(url ? { url, name } : null);
    };
    context.on('response', onResponse);
    context.on('download', onDownload);
    const timer = setTimeout(() => finish(null), ms);
  });
}

async function closeExtraPages(context) {
  const pages = context.pages();
  for (let i = 1; i < pages.length; i++) {
    try { await pages[i].close(); } catch (_) {}
  }
}

/* Click one quality row's Download control and capture the direct CDN URL it
   produces. Retries once. Returns null when the row gives no usable link. */
async function captureRow(context, page, rowText, waitMs, qualityNum) {
  const locator = page.locator('li', { hasText: rowText }).locator('div[aria-disabled="false"]').first();
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = captureLink(context, waitMs);
    let clickOk = false;
    try { await locator.click({ timeout: 12000 }); clickOk = true; } catch (e) { clickOk = false; }
    const r = await wait;
    await closeExtraPages(context);
    console.log('[extractor]  row="' + rowText.slice(0, 20) + '" attempt=' + attempt + ' click=' + (clickOk ? 'ok' : 'fail') + ' got=' + (r && r.url ? 'link' : 'none'));
    if (r && r.url) {
      // Reject a stray/duplicate redirect that doesn't belong to this row's
      // quality (vidssave re-emits recent links with a delay).
      const matches = qualityNum === 0 || new RegExp(qualityNum + '[pP]').test(r.url);
      if (matches) return r;
      console.log('[extractor]  row="' + rowText.slice(0, 20) + '" wrong-quality link discarded');
    }
    await sleep(800);
  }
  return null;
}

async function extractFromPage(context, page, videoUrl) {
  const t0 = Date.now();
  let gotoErr = null;
  try { await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { gotoErr = e; }
  await page.waitForTimeout(3500);

  const diag = await page.evaluate(() => {
    const b = document.body ? document.body.innerText : '';
    return {
      title: document.title || '',
      url: location.href,
      hasInput: !!document.querySelector('input#url-input-wrapper'),
      body: b.replace(/\s+/g, ' ').slice(0, 300)
    };
  }).catch(() => ({}));
  console.log('[extractor] goto=' + (gotoErr ? 'err:' + gotoErr.message.slice(0, 80) : 'ok') + ' title=' + JSON.stringify(diag.title) + ' hasInput=' + diag.hasInput + ' body=' + JSON.stringify((diag.body || '').slice(0, 140)));

  const input = page.locator('input#url-input-wrapper').first();
  try {
    await input.waitFor({ state: 'visible', timeout: 20000 });
    await input.click({ timeout: 10000 });
  } catch (e) {
    throw new Error('vidssave did not render its form for this server IP (input#url-input-wrapper missing). title="' + (diag.title || '') + '" body="' + (diag.body || '').slice(0, 160) + '"');
  }
  await input.type(videoUrl, { delay: 8 });
  await page.waitForTimeout(700);
  try {
    await page.getByRole('button', { name: 'Download' }).first().click({ timeout: 10000 });
  } catch (e) {
    throw new Error('vidssave Download button did not appear. title="' + (diag.title || '') + '"');
  }

  const rows = await waitForRows(page, 4, 75000);
  const videoRows = rows.filter((r) => !r.isAudio);
  const audioRows = rows.filter((r) => r.isAudio);
  console.log('[extractor] parsed rows=' + rows.length + ' video=' + videoRows.length + ' audio=' + audioRows.length + ' in ' + (Date.now() - t0) + 'ms');

  const meta = await fetchOembed(videoUrl);
  const ytId = youtubeVideoId(videoUrl);

  // HD rows (>=1080P) open an upsell modal instead of a direct download and can
  // cover the result list, so probe the reliable lower qualities from low to
  // high, keep up to 4, then label the two best as hd/sd.
  const videoAsc = videoRows.slice().sort((a, b) => a.qualityNum - b.qualityNum);

  const variants = [];
  const videoHits = [];
  for (const r of videoAsc) {
    if (videoHits.length >= 4 || (r.qualityNum === 0 && videoHits.length > 0)) break;
    if (r.qualityNum >= 1080) continue;
    const c = await captureRow(context, page, r.text, 9000, r.qualityNum);
    if (c) videoHits.push({ r, c });
  }
  videoHits.sort((a, b) => b.r.qualityNum - a.r.qualityNum);
  if (videoHits[0]) variants.push({ key: 'hd', ext: 'mp4', url: videoHits[0].c.url, label: videoHits[0].r.qualityNum + 'P' });
  if (videoHits[1]) variants.push({ key: 'sd', ext: 'mp4', url: videoHits[1].c.url, label: videoHits[1].r.qualityNum + 'P' });

  console.log('[extractor] variants=' + variants.map((v) => v.key).join(',') + ' total=' + (Date.now() - t0) + 'ms');
  return {
    title: meta.title || 'YouTube video',
    author: meta.author || '',
    thumbnail: ytId ? 'https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg' : '',
    platform: 'youtube',
    variants
  };
}

async function doExtract(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 1200 },
    acceptDownloads: true
  });
  try {
    const page = await context.newPage();
    return await extractFromPage(context, page, url);
  } finally {
    try { await context.close(); } catch (_) {}
  }
}

app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'VidSave extractor backend' });
});

app.get('/api/extract', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (String(url).indexOf('youtube.com') === -1 && String(url).indexOf('youtu.be') === -1) {
    return res.status(400).json({ error: 'only youtube urls supported' });
  }

  withLock(() => doExtract(url)).then((result) => {
    if (!result.variants.length) {
      return res.status(422).json({ error: 'vidssave did not expose any download link for this video. It may be private, removed, or blocked from this server\u2019s IP. Try again in a minute.' });
    }
    res.json(result);
  }).catch((e) => {
    console.log('[extractor] error: ' + (e && e.message));
    res.status(500).json({ error: (e && e.message) || 'extraction failed' });
  });
});

async function main() {
  await ensureChromium();
  await getBrowser();
  app.listen(PORT, () => {
    console.log('extractor running on ' + PORT);
  });
}

main().catch(function (e) {
  console.error('Fatal boot error:', e.message);
  process.exit(1);
});
