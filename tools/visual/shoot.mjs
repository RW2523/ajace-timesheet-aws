// Screenshot every scene render-gallery.cjs produced, at the three viewports
// this app is actually used at. Local file:// only — no server, no network.
//
// Overlay scenes (.modal-bg is position:fixed) are shot at exactly the viewport,
// because that is what the user sees; a fullPage shot of them would be the same
// pixels. Page scenes are shot fullPage so a banner 3000px down still lands in
// the image.
//
// Also reports, per scene+viewport, whether the DOCUMENT scrolls sideways — a
// cheap machine check for the class of layout break a human eye skims past.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, "out");
const manifest = JSON.parse(readFileSync(path.join(OUT, "manifest.json"), "utf8"));

const VIEWPORTS = [
  { tag: "390x844", width: 390, height: 844 },
  { tag: "768x1024", width: 768, height: 1024 },
  { tag: "1280x800", width: 1280, height: 800 },
];

const browser = await chromium.launch();
const made = [];
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",   // else the success-card pop animation is caught mid-flight
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  for (const s of manifest) {
    await page.goto(pathToFileURL(s.file).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const box = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      sh: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    }));
    const hScroll = box.sw > box.cw + 1;

    if (s.overlay) {
      const file = path.join(OUT, `${s.name}__${vp.tag}.png`);
      await page.screenshot({ path: file });
      made.push({ file, scene: s.name, vp: vp.tag, hScroll });
      continue;
    }
    // Chromium refuses a capture taller than ~16384 DEVICE pixels, and at
    // deviceScaleFactor 2 the review page blows straight through that on a
    // phone. Dropping the scale factor to fit would defeat the point of the
    // harness (the thing being inspected is 13px type), so tall pages are TILED
    // at full resolution instead — same pixels, more files.
    const SLICE = 7200;                       // CSS px; 14400 device px, under the cap
    if (box.sh <= SLICE) {
      const file = path.join(OUT, `${s.name}__${vp.tag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      made.push({ file, scene: s.name, vp: vp.tag, hScroll });
    } else {
      const parts = Math.ceil(box.sh / SLICE);
      for (let i = 0; i < parts; i++) {
        const y = i * SLICE;
        const file = path.join(OUT, `${s.name}__${vp.tag}__p${i + 1}of${parts}.png`);
        await page.screenshot({
          path: file, fullPage: true,
          clip: { x: 0, y, width: box.cw, height: Math.min(SLICE, box.sh - y) },
        });
        made.push({ file, scene: s.name, vp: vp.tag, hScroll });
      }
    }
  }
  if (errs.length) console.error(`page errors @${vp.tag}:`, errs);
  await ctx.close();
}
await browser.close();

for (const m of made) console.log(`${m.hScroll ? "HSCROLL " : "        "}${m.file}`);
console.log(`\n${made.length} screenshots.`);
const bad = made.filter((m) => m.hScroll);
if (bad.length) console.log("horizontal document overflow: " + bad.map((b) => `${b.scene}@${b.vp}`).join(", "));
