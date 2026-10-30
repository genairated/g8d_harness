// render-service/screenshot.js — headless slide screenshots via Playwright
// slidesToPngs(deckUrl, opts) → [{ index, pngBuffer, transcript }]
const { getBrowser } = require('./index');

// Load the deck, wait for presentation-core, hide the playback shell. Returns the slide count.
async function prepareDeckPage(page, deckUrl, bodyClasses = []) {
  const resp = await page.goto(deckUrl, { waitUntil: 'networkidle', timeout: 30000 });
  // A 404 here (e.g. wrong workspace in the URL) would otherwise surface as the misleading
  //「找不到 .slide」below — report the real cause instead.
  if (resp && !resp.ok()) throw new Error(`deck 載入失敗（HTTP ${resp.status()}）：${deckUrl}`);

  // Wait for presentation-core to finish initialising
  await page.waitForSelector('[data-core-init="1"]', { timeout: 15000 }).catch(() => {
    // deck may not use presentation-core — proceed anyway
  });

  // Hide core shell UI (progress bar / footer / drawer / overlay) during export
  // Also force-reveal animation elements so they appear in screenshots / pptx.
  await page.addStyleTag({
    content: `
      body.exporting .progress-wrap,
      body.exporting .timer,
      body.exporting footer,
      body.exporting .tech-panel,
      body.exporting .drawer,
      body.exporting .overlay,
      body.exporting #initOverlay,
      body.exporting #hanaAvatarFloat,
      body.exporting #hana-float-widget { display: none !important; }
      body.exporting:not(.export-cue-frames) [data-anim] { opacity: 1 !important; transform: none !important; transition: none !important; }
      body.export-cue-frames [data-anim],
      body.export-cue-frames .slide { transition: none !important; }
    `
  });
  await page.evaluate((cls) => { document.body.classList.add('exporting'); cls.forEach(c => document.body.classList.add(c)); }, bodyClasses);

  const slideCount = await page.$$eval('.slide', els => els.length);
  if (slideCount === 0) throw new Error('找不到 .slide 元素，請確認 deck 使用 presentation-core 架構');
  return slideCount;
}

async function slidesToPngs(deckUrl, { width = 1920, height = 1080, waitMs = 300 } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();

  try {
    const slideCount = await prepareDeckPage(page, deckUrl);

    const results = [];
    for (let i = 0; i < slideCount; i++) {
      // Activate slide i (remove active from all, add to i-th)
      await page.evaluate((idx) => {
        document.querySelectorAll('.slide').forEach((el, j) => {
          el.classList.toggle('active', j === idx);
          el.classList.toggle('previous-slide', j === idx - 1);
        });
      }, i);

      // PRES-CUE: slides with data-cues are rendered in their FINAL state (all cues applied, no laser).
      await page.evaluate((idx) => { if (window.__presCore) window.__presCore.finalizeSlide(idx); }, i);

      await page.waitForTimeout(waitMs);

      // Screenshot the viewport element only (clips to 1920×1080)
      const pngBuffer = await page.screenshot({
        clip: { x: 0, y: 0, width, height },
        type: 'png',
      });

      const transcript = await page.evaluate((idx) => {
        const slide = document.querySelectorAll('.slide')[idx];
        if (!slide) return '';
        if (slide.dataset.transcript) return slide.dataset.transcript;
        // PRES-CUE fallback: no data-transcript → join every cue's `say` (notes must carry the full narration)
        const cues = window.__presCore ? window.__presCore.cues(idx) : null;
        return cues ? cues.map(c => c.say || '').join('') : '';
      }, i);

      results.push({ index: i, pngBuffer, transcript });
    }

    return results;
  } finally {
    await context.close();
  }
}

function activateSlide(page, i) {
  return page.evaluate((idx) => {
    document.querySelectorAll('.slide').forEach((el, j) => {
      el.classList.toggle('active', j === idx);
      el.classList.toggle('previous-slide', j === idx - 1);
    });
  }, i);
}

// PRES-CUE (mp4): one frame per cue. Slides with data-cues yield one segment per cue — the screen
// state right after that cue's action (laser included), its `say`, and its `pause` (default 600ms).
// Slides without cues yield a single segment = final state + whole data-transcript, pauseMs 0
// (identical to the pre-cue recorder). Motion between states (count roll / path draw) is NOT
// captured — each segment is a still frame; see SPEC-presentation-export.md §9.1.
// → [{ slide, cue, pngBuffer, say, pauseMs }]
async function slidesToSegments(deckUrl, { width = 1920, height = 1080, waitMs = 450 } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  try {
    const slideCount = await prepareDeckPage(page, deckUrl, ['export-cue-frames', 'export-keep-laser']);
    const out = [];
    for (let i = 0; i < slideCount; i++) {
      await activateSlide(page, i);
      const cues = await page.evaluate((idx) => (window.__presCore ? window.__presCore.cues(idx) : null), i);
      if (cues && cues.length) {
        for (let k = 0; k < cues.length; k++) {
          await page.evaluate(([idx, kk]) => window.__presCore.cueState(idx, kk), [i, k]);
          await page.waitForTimeout(waitMs);
          const pngBuffer = await page.screenshot({ clip: { x: 0, y: 0, width, height }, type: 'png' });
          const p = parseInt(cues[k].pause, 10);
          out.push({ slide: i, cue: k, pngBuffer, say: cues[k].say || '', pauseMs: Number.isFinite(p) && p >= 0 ? p : 600 });
        }
      } else {
        await page.evaluate((idx) => {
          if (window.__presCore) window.__presCore.finalizeSlide(idx);
          const s = document.querySelectorAll('.slide')[idx];
          if (s) s.querySelectorAll('[data-anim]').forEach(el => el.classList.add('anim-visible'));
        }, i);
        await page.waitForTimeout(waitMs);
        const pngBuffer = await page.screenshot({ clip: { x: 0, y: 0, width, height }, type: 'png' });
        const say = await page.evaluate((idx) => {
          const s = document.querySelectorAll('.slide')[idx];
          return s ? (s.dataset.transcript || s.dataset.notes || '') : '';
        }, i);
        out.push({ slide: i, cue: -1, pngBuffer, say, pauseMs: 0 });
      }
    }
    return out;
  } finally {
    await context.close();
  }
}

module.exports = { slidesToPngs, slidesToSegments };
