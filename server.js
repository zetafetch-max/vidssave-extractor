const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* ---------------------------------------------------------------------------
   Chromium self-heal
   If the Playwright browser binary is missing (e.g. Render built with only
   `npm install`), download it on boot. Cached after first time.
   ------------------------------------------------------------------------- */
async function ensureChromium() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function youtubeVideoId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/|watch\/(?:v\/)?)([A-Za-z0-9_-]{11})/);
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

/* Collect the quality rows vidssave renders after parsing. Runs in-browser. */
function collectRows() {
  const rows = [];
  const lis = Array.from(document.querySelectorAll('li'));
  for (const li of lis) {
    const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/Download/i.test(t) || !/MP4|MP3/i.test(t)) continue;
    const q = (t.match(/\b(144|240|360|480|720|1080|2160|4k|48|96|128|256)K?\s*P?\b/i) || [])[0] || '';
    rows.push({
      text: t.slice(0, 42),
      isAudio: /MP3/i.test(t),
      qualityLabel: q
    });
  }
  return rows;
}

/* Click one quality row's Download control and capture the direct CDN URL it
   produces (Playwright's `download` event resolves the final URL). Retries
   once. Returns null when the row gives no usable link. */
async function captureRow(page, rowText, waitMs) {
  const locator = page.locator('li', { hasText: rowText }).locator('div[aria-disabled="false"]').first();
  for (let attempt = 0; attempt < 2; attempt++) {
    const dlPromise = new Promise((resolve) => {
      const handler = (d) => {
        page.off('download', handler);
        const url = d.url();
        d.cancel && d.cancel().catch(() => {});
        resolve({ url, name: d.suggestedFilename() || '' });
      };
      page.on('download', handler);
    });
    try {
      const ok = await withTimeout(locator.click({ timeout: 15000 }).then(() => true), 16000).catch(() => false);
      if (!ok) return null;
    } catch (_) { /* continue */ }
    const r = await withTimeout(dlPromise, waitMs).catch(() => null);
    if (r && r.url && !/^blob:/.test(r.url)) return r;
  }
  return null;
}

async function extractFromPage(page, videoUrl) {
  await page.goto('https://vidssave.com/youtube-video-downloader-8hs', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4000);

  const input = page.locator('input#url-input-wrapper').first();
  await input.click();
  await input.type(videoUrl, { delay: 8 });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Download' }).first().click();

  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return /MP4|144P|720P|1080P|MP3/.test(t);
  }, { timeout: 70000 }).catch(() => {});

  await page.waitForTimeout(1000);
  const rows = await page.evaluate(collectRows);
  const videoRows = rows.filter((r) => !r.isAudio);
  const audioRows = rows.filter((r) => r.isAudio);

  const pickHigh = (list) => {
    if (!list.length) return null;
    const byQual = [];
    for (const r of list) {
      const n = parseInt(String(r.qualityLabel || '0').replace(/\D/g, ''), 10) || 0;
      byQual.push({ row: r, n });
    }
    byQual.sort((a, b) => b.n - a.n);
    return byQual[0].row;
  };
  const pickLow = (list, highRow) => {
    if (list.length < 2) return null;
    return list.find((r) => r !== highRow) || list[list.length - 1];
  };

  const hdRow = pickHigh(videoRows);
  const sdRow = pickLow(videoRows, hdRow);
  const audioRow = audioRows[0] || null;

  const meta = await fetchOembed(videoUrl);
  const ytId = youtubeVideoId(videoUrl);

  const variants = [];
  if (hdRow) {
    const c = await captureRow(page, hdRow.text, 25000);
    if (c) variants.push({ key: 'hd', ext: 'mp4', url: c.url });
  }
  if (sdRow) {
    await sleep(1500);
    const c = await captureRow(page, sdRow.text, 25000);
    if (c) variants.push({ key: 'sd', ext: 'mp4', url: c.url });
  }
  if (audioRow) {
    await sleep(1500);
    const c = await captureRow(page, audioRow.text, 45000);
    if (c) variants.push({ key: 'audio', ext: 'mp3', url: c.url });
  }

  return {
    title: meta.title || 'YouTube video',
    author: meta.author || '',
    thumbnail: ytId ? 'https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg' : '',
    platform: 'youtube',
    variants
  };
}

app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'VidSave extractor backend' });
});

app.get('/api/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (String(url).indexOf('youtube.com') === -1 && String(url).indexOf('youtu.be') === -1) {
    return res.status(400).json({ error: 'only youtube urls supported' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const result = await extractFromPage(page, url);
    if (!result.variants.length) {
      return res.status(422).json({ error: 'vidssave did not expose any download link for this video. It may be private, removed, or blocked from this server\u2019s IP. Try again in a minute.' });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

async function main() {
  await ensureChromium();
  app.listen(PORT, () => {
    console.log('extractor running on ' + PORT);
  });
}

main().catch(function (e) {
  console.error('Fatal boot error:', e.message);
  process.exit(1);
});