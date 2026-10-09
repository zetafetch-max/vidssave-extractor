# VidSave Extractor Backend

Small headless browser backend to extract real direct download links from vidssave.com.

## Deploy to Render (free)

1. Push this `backend/` folder to a Git repo
2. Create new Web Service on Render, connect repo, set root to `backend/`
3. Build Command: `npm install`
4. Start Command: `npx playwright install chromium && node server.js` (or just `node server.js` if using system chromium)
   - For Render, better: add `playwright install chromium` in start or use `npm start`
5. Set env: `PORT=10000` (Render sets automatically)
6. Deploy. Get URL like `https://vidssave-extractor.onrender.com`

## Test

`GET https://your-url/api/extract?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ`

Returns JSON with `title`, `thumbnail`, `variants` (mp4/mp3 direct links).

## Deploy to Railway

1. New project > Deploy from GitHub > select repo, root `backend/`
2. Start command: `node server.js`
3. Add build: `npm install && npx playwright install chromium`
4. Deploy.
