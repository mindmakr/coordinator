// Browser check for the walkable maps (Flow, Goal relevance): the pointer reaches what it
// is over. For every box, 15 points inside it must hit that box (never a line); for every
// line, nine points along it (those not inside a box) must hit that line, or, where two
// lines truly cross, a line whose own 4 px centre stroke holds the point too. Needs Playwright, so it is
// not in `npm test`:
//   PLAYWRIGHT=<path to the playwright package> node hits.check.mjs <maps page URL>…
// Exit code 1 when any point goes to the wrong element.
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT);
const urls = process.argv.slice(2);
let failed = 0;
const browser = await chromium.launch();
for (const width of [1280, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  for (const url of urls) {
    await page.goto(url); await page.waitForTimeout(600);
    const res = await page.evaluate(() => {
      const out = { boxes: 0, boxBad: [], lines: 0, points: 0, crossings: 0, lineBad: [] };
      const toScreen = (el, q) => { const m = el.getScreenCTM(); return [q.x * m.a + q.y * m.c + m.e, q.x * m.b + q.y * m.d + m.f]; };
      for (const svg of document.querySelectorAll('svg[data-nav]')) {
        for (const n of svg.querySelectorAll('[data-node]')) {
          const rect = n.querySelector('rect'); if (!rect) continue;
          rect.scrollIntoView({ block: 'center', inline: 'center' }); out.boxes++;
          const r = rect.getBoundingClientRect();
          for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) for (const fy of [0.3, 0.5, 0.7]) {
            const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
            if ((el && el.closest('[data-node]')) !== n) out.boxBad.push(`${svg.dataset.nav} ${n.dataset.node} at ${fx},${fy}: ${el ? (el.closest('[data-edge]') ? `line ${el.closest('[data-edge]').dataset.from}>${el.closest('[data-edge]').dataset.to}` : el.tagName) : 'nothing'}`);
          }
        }
        const rects = [...svg.querySelectorAll('[data-node] rect')];
        for (const g of svg.querySelectorAll('.eg')) {
          const m = g.dataset.edge; const hit = svg.querySelector(`.hit[data-edge="${m}"]`); const L = hit.getTotalLength(); out.lines++;
          for (let i = 1; i <= 9; i++) {
            const q = hit.getPointAtLength((L * i) / 10);
            // Bring the point itself into view: a long line can be wider than the map's box on a phone.
            const box = svg.closest('.map-scroll'); let [x, y] = toScreen(hit, q); const c = box.getBoundingClientRect();
            box.scrollLeft += x - (c.left + c.width / 2); box.scrollTop += y - (c.top + c.height / 2);
            [x, y] = toScreen(hit, q); scrollBy(0, y - innerHeight / 2); [x, y] = toScreen(hit, q);
            if (rects.some((b) => { const r = b.getBoundingClientRect(); return x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3; })) continue; // a box and its border are the box's own ground
            out.points++;
            const el = document.elementFromPoint(x, y); const owner = el && el.closest('[data-edge]');
            if (owner && owner.dataset.edge === m) continue;
            // A true crossing: the other line's own centre (its narrow target, 4 px) holds the point too.
            const thin = owner && svg.querySelector(`.hit.thin[data-edge="${owner.dataset.edge}"]`);
            if (thin && thin.isPointInStroke(new DOMPoint(q.x, q.y))) { out.crossings++; continue; }
            const said = (o) => svg.querySelector(`.eg[data-edge="${o.dataset.edge}"]`).getAttribute('aria-label');
            out.lineBad.push(`${svg.dataset.nav} ${g.getAttribute('aria-label')} point ${i}: ${owner ? said(owner) : el ? (el.closest('[data-node]')?.dataset.node ?? el.tagName) : 'nothing'}`);
          }
        }
      }
      return out;
    });
    const bad = res.boxBad.length + res.lineBad.length; failed += bad;
    console.log(`${width}px ${url.replace(/\?.*/, '')}: ${res.boxes} boxes, ${res.lines} lines, ${res.points} line points, ${res.crossings} at crossings, ${bad} wrong`);
    for (const b of [...res.boxBad, ...res.lineBad].slice(0, 20)) console.log(`  ${b}`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
