const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'VidSave extractor backend' });
});

app.get('/api/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!String(url).includes('youtube.com') && !String(url).includes('youtu.be')) {
    return res.status(400).json({ error: 'only youtube urls supported' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    const target = `https://vidssave.com/youtube-video-downloader-8hs?v=${encodeURIComponent(url)}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // wait for links to appear
    await page.waitForTimeout(4000);
    try {
      await page.waitForSelector('a[href*=".mp4"], a[href*=".mp3"], button, .download', { timeout: 15000 });
    } catch (e) {
      // continue
    }

    const result = await page.evaluate(() => {
      const out = { title: null, thumbnail: null, variants: [] };
      const titleEl = document.querySelector('title');
      if (titleEl) out.title = titleEl.textContent.replace(/ - VidsSave/i, '').trim();
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        if ((src.includes('ytimg') || src.includes('thumbnail') || src.includes('hqdefault')) && src.startsWith('http')) {
          out.thumbnail = src; break;
        }
      }
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const a of links) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const abs = href.startsWith('http') ? href : (location.origin + (href.startsWith('/') ? href : '/' + href));
        const low = abs.toLowerCase();
        const text = (a.textContent || '').toLowerCase();
        if (low.includes('.mp4') || low.includes('mp4')) {
          let key = 'sd';
          if (low.includes('1080') || text.includes('1080')) key = 'hd';
          else if (low.includes('720') || text.includes('720')) key = 'hd';
          else if (low.includes('480') || text.includes('480')) key = 'sd';
          else if (low.includes('360') || text.includes('360')) key = 'sd';
          out.variants.push({ key, ext: 'mp4', url: abs });
        }
        if ((low.includes('.mp3') || low.includes('mp3')) && !out.variants.find(v => v.ext === 'mp3' && v.url === abs)) {
          out.variants.push({ key: 'audio', ext: 'mp3', url: abs });
        }
      }
      // dedupe
      const seen = new Set();
      out.variants = out.variants.filter(v => {
        if (seen.has(v.url)) return false;
        seen.add(v.url);
        return true;
      });
      return out;
    });

    if (!result.variants.length) {
      // second pass
      await page.waitForTimeout(5000);
      const result2 = await page.evaluate(() => {
        const out = { variants: [] };
        const links = Array.from(document.querySelectorAll('a[href]'));
        for (const a of links) {
          const href = a.getAttribute('href');
          if (!href) continue;
          const abs = href.startsWith('http') ? href : (location.origin + (href.startsWith('/') ? href : '/' + href));
          const low = abs.toLowerCase();
          const text = (a.textContent || '').toLowerCase();
          if (low.includes('.mp4') || low.includes('mp4')) {
            let key = 'sd';
            if (low.includes('1080') || text.includes('1080')) key = 'hd';
            else if (low.includes('720') || text.includes('720')) key = 'hd';
            out.variants.push({ key, ext: 'mp4', url: abs });
          }
          if (low.includes('.mp3') && !out.variants.find(v => v.ext === 'mp3' && v.url === abs)) {
            out.variants.push({ key: 'audio', ext: 'mp3', url: abs });
          }
        }
        const seen = new Set();
        out.variants = out.variants.filter(v => { if (seen.has(v.url)) return false; seen.add(v.url); return true; });
        return out;
      });
      result.variants = result2.variants;
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`extractor running on ${PORT}`);
});
