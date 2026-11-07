// A run's maps page (/maps when served, live; maps.html beside hud.html in the
// snapshot, static SVG): one section per entry of MAPS, each a keyed block the
// live page patches in place. To add a map, add an entry: { id, title, about,
// render(view, ctx, nowMs) }. Same shell, theme and escaping rules as the dashboard.
import { liveCtx, staticCtx } from './hud.mjs';
import { blk, esc, page, stamp } from './parts.mjs';
import { behaviourSvg, flowSvg, heatSvg, mindSvg, relevanceSvg } from './mapsvg.mjs';
import { unitTips } from './maptips.mjs';
import { callsView } from './map/callsview.mjs';

export const MAPS = [
  { id: 'mind', title: 'Mind map', about: 'The goal at the centre, then units, their behaviours and evidence, coloured by status.', render: mindSvg },
  { id: 'flow', title: 'Flow', about: 'What waits on what: stacked units, the issues and PRs they link (another repo dashed), follow-ups filed during the run, and the critical path.', render: flowSvg },
  { id: 'heat', title: 'Activity by hour', about: 'Where effort and churn went: tries, failures, heartbeats and waiting, per unit and hour.', render: heatSvg },
  { id: 'behaviours', title: 'Behaviours', about: 'Each unit’s behaviours, pass or fail.', render: behaviourSvg },
  { id: 'relevance', title: 'Goal relevance', about: 'Which goal behaviours each unit serves, so work off the goal stands out.', render: relevanceSvg },
  { id: 'calls', title: 'Calls', about: 'For one unit: the JS/TS functions its diff touched, what calls them and what they call (run.mjs calls).', render: callsView },
];

export function mapsPage(v, nowMs = Date.now(), ctx = null) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const toc = `<nav class="toc" aria-label="Maps">${MAPS.map((m) => `<a href="#map-${m.id}">${esc(m.title)}</a>`).join('')}</nav>`;
  const body = [
    `<a class="back" href="${esc(ctx.home)}">← ${esc(v.id)} dashboard</a>`,
    blk('head', `<header class="run"><h1>Maps · ${esc(v.id)}</h1><span class="meta">${esc(v.phase)} · updated ${stamp(new Date(nowMs).toISOString())}</span></header>`),
    toc,
    ...MAPS.map((m) => `<h2 id="map-${m.id}" data-a="h-${m.id}">${esc(m.title)}</h2>`
      + blk(`map-${m.id}`, `<p class="meta">${esc(m.about)}</p>${m.render(v, ctx, nowMs)}`, 'section', ` class="maps" aria-labelledby="map-${m.id}"`)),
    // One stats panel per unit, shared by every map's box for that unit (lib/maptips.mjs).
    blk('map-tips', unitTips(v, ctx, nowMs)),
  ].join('\n');
  return page({ title: `Maps · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/maps`, closed: !v.open });
}
