// Plush Crew Launch Video: the collaborative workspace (chat, cursors, assets, preview, timeline, camera).
// Deterministic: window.__film.seek(t) draws time t exactly. Time is authored in beats of the soundtrack
// (b = (t - offset) / beat, from beats.json). storyboard.json holds every word, color and image; the beat
// grid of the choreography is fixed, so any product fits the same 76-beat film.
(() => {
const FPS = 30;
const stage = document.getElementById('stage');
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const eOut = k => 1 - Math.pow(1 - clamp(k), 3);
const eIn = k => Math.pow(clamp(k), 3);
const eInOut = k => { k = clamp(k); return k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const eBack = k => { k = clamp(k); const c = 1.7; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const spring = (dt, amp, k = 7, w = 18) => dt < 0 ? 0 : amp * Math.exp(-dt * k) * Math.cos(dt * w);
const el = (tag, cls, parent, css) => { const e = document.createElement(tag); if (cls) e.className = cls; if (css) Object.assign(e.style, css); if (parent) parent.appendChild(e); return e; };
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pending = [];
function img(parent, src, css, cls = 'abs') { const i = el('img', cls, parent, css); i.src = src; pending.push(i.decode().catch(() => {})); return i; }
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

// ---------- colors ----------
const hex = c => { const m = String(c).replace('#', ''); const n = parseInt(m.length === 3 ? m.replace(/./g, x => x + x) : m, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = rgb => '#' + rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const mix = (a, b, k) => { const A = hex(a), B = hex(b); return toHex(A.map((v, i) => lerp(v, B[i], k))); };
const tint = c => mix(c, '#ffffff', .82);
const deep = c => mix(c, '#121313', .45);

// ---------- Lucide icons (inline SVG, never emoji) ----------
const NODES = window.FILM_ICONS || {};
function iconBody(name) {
  const n = NODES[name] || NODES.sparkles;
  if (!n) return '';
  return n.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
}
const FILLED = { play: '<path d="m6 3 14 9-14 9V3z" fill="currentColor"/>', pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>' };
function icon(name, size = 20, color = 'currentColor', sw = 2) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="color:${color};flex:none">${FILLED[name] || iconBody(name)}</svg>`; }

// ---------- the product mark on its tile; draw(k) reveals it from the bottom-left ----------
let SB = null;
function tile(parent, size, css = {}) {
  const P = SB.product;
  const t = el('div', 'tile', parent, { position: 'absolute', width: size + 'px', height: size + 'px', ...css });
  const pad = P.markPad ?? .18;
  const m = img(t, P.mark, { left: pad * 100 + '%', top: pad * 100 + '%', width: (1 - 2 * pad) * 100 + '%', height: (1 - 2 * pad) * 100 + '%' }, 'mark');
  t.mark = m; t.size = size;
  t.draw = k => { m.style.clipPath = `inset(${(1 - k) * 100}% ${(1 - k) * 100}% 0 0)`; };
  return t;
}
// the product name: text in the display face, or the wordmark image when the storyboard gives one
function wordmark(parent, px, css = {}) {
  const P = SB.product;
  if (P.wordmark) {
    const w = el('div', 'abs', parent, { height: px + 'px', whiteSpace: 'nowrap', ...css });
    const i = img(w, P.wordmark, { position: 'static', height: '100%', width: 'auto' }, '');
    w.measure = () => i.naturalWidth ? i.naturalWidth / i.naturalHeight * px : px * 4;
    w.vpad = 0;
    return w;
  }
  const w = el('div', 'abs', parent, { font: `700 ${px}px/1 var(--display)`, letterSpacing: '-.04em', whiteSpace: 'nowrap', ...css });
  w.textContent = P.name;
  w.measure = () => w.scrollWidth;
  return w;
}
window.__fx = { clamp, lerp, eOut, eIn, eInOut, eBack, spring, el, esc, icon, img, CJK, tile, wordmark, mix, tint, deep };

// ---------- layout (world px) ----------
const CH = { x: 16, y: 88, w: 480, h: 976 };
const AS = { x: 520, y: 88, w: 72, h: 736 };
const PV = { x: 600, y: 88, w: 1216, h: 736 };
const CV = { x: 600, y: 140, w: 1216, h: 684 };
const FS = CV.w / 1920;
const TL = { x: 512, y: 836, w: 1392, h: 228 };
const LX0 = 616, LW = 1280, LANE_TOP = 858, LANE_STEP = 40, LANE_H = 34;
const LY = [0, 1, 2, 3, 4].map(i => LANE_TOP + i * LANE_STEP + LANE_H / 2);   // Shots, Titles, Motion, Music, SFX centres
const lx = fb => LX0 + fb / 48 * LW;                                           // film-in-film beat -> lane x
const RENDER = { x: 1772, y: 16, w: 132, h: 40 };
const PLAY = { x: 612, y: 97, w: 104, h: 34 };
const toWorld = (fx, fy) => [CV.x + fx * FS, CV.y + fy * FS];
const GUT = k => [AS.x + AS.w / 2, AS.y + 72 + ['logo_rise', 'hero_line', 'music', 'logo_strip', 'sfx'].indexOf(k) * 60];
window.__fx.layout = { CH, AS, PV, CV, FS, TL, LX0, LW, LY, lx, toWorld };

// fixed chat slots: beat, sender and what the line is for (storyboard.chat.<slot> fills the words)
const CHAT = [
  ['open', .5, 'human', 1], ['hero_joke', 6.5, 'c5', .5], ['bite', 13.5, 'c5', .5], ['wall_q', 20.5, 'human', .5],
  ['wall_a', 22.5, 'c3', 1], ['slot_q', 33.5, 'c4', .5], ['how_q', 38.5, 'c3', 1], ['how_a', 40.5, 'c2', 1],
  ['sticker', 45, 'human', .5], ['source', 47, 'c2', .5], ['fair', 49, 'human', .5], ['proof_joke', 51.5, 'c5', 1],
  ['tagline', 53.5, 'c2', 1], ['taste', 61.5, 'c5', 1], ['close', 63.5, 'human', 1],
];

let BEAT = .5, OFF = 1, DUR = 40, HL = '#f4ff71', INK = '#121313', BRAND = '#d97757';
const bOf = t => (t - OFF) / BEAT;
const ready = (async () => {
  SB = await (await fetch('storyboard.json')).json();
  const bj = await (await fetch('beats.json')).json();
  BEAT = bj.beat; OFF = bj.offset; DUR = bj.duration; window.__fx.BEAT = BEAT;
  HL = SB.palette.highlight; INK = SB.palette.ink; BRAND = SB.palette.brand;
  window.__fx.HL = HL; window.__fx.INK = INK; window.__fx.BRAND = BRAND; window.__fx.SB = SB;
  window.__fx.cjk = !!SB.cjk;
  if (SB.cjk) stage.classList.add('cjk');
  // unicode-range subsets load lazily; load every face up front so no frame is captured with a fallback font
  await Promise.all([...document.fonts].map(f => f.load().catch(() => {})));
  await document.fonts.ready;
  build();
  window.__film.duration = DUR;
  const T = b => +(OFF + b * BEAT).toFixed(3);
  window.__film.scenes = [['workspace', -2, 8], ['brand', 8, 16], ['what', 16, 28], ['fit', 28, 36], ['how', 36, 48], ['proof', 48, 56], ['render', 56, 66], ['push-in', 66, 68], ['end', 68, 76]]
    .map(([type, a, z], index) => ({ index, type, start: Math.max(0, T(a)), dur: Math.min(DUR, T(z)) - Math.max(0, T(a)) }));
})();

const CREW = {}; const W = {};
const crewFile = c => c.file;
function build() {
  const ui = SB.ui;
  for (const c of SB.crew) CREW[c.id] = c;
  el('div', 'fill', stage, { background: `radial-gradient(55% 60% at 100% 0%, ${BRAND}24, transparent 60%), radial-gradient(50% 55% at 0% 100%, ${HL}61, transparent 60%), var(--bg)` });
  const world = el('div', '', stage); world.id = 'world'; W.world = world;
  const top = el('div', 'abs', world, { width: '1920px', height: '72px' }); W.top = top;
  tile(top, 40, { left: '16px', top: '16px' }).draw(1);
  const wm = wordmark(top, 32, { left: '66px', top: '18px', letterSpacing: '-.02em' }); W.wm = wm;
  if (SB.workspace.conceptLabel) { W.chip1 = el('div', 'chipc', top, { position: 'absolute', left: '196px', top: '14px' }); W.chip1.textContent = SB.workspace.conceptLabel; }
  const title = el('div', 'abs', top, { left: '0', top: '25px', font: '600 20px var(--ui)', color: '#55534d', display: 'flex', gap: '8px', alignItems: 'center', whiteSpace: 'nowrap' }); title.innerHTML = `${icon('film', 19, '#8a867d', 2)}<span>${esc(SB.workspace.projectTitle)}</span>`; W.title = title;
  const share = el('div', 'btn abs', top, { left: '1650px', top: '19px', background: '#fff', boxShadow: '0 0 0 1px #ddd7cb', height: '34px' }); share.innerHTML = icon('share', 16, INK, 2) + esc(ui.share);
  buildRender(top, ui); buildChat(world, ui); buildAssets(world, ui); buildPreview(world, ui); buildTimeline(world, ui);
  W.overlay = el('div', 'fill', world); buildPointers();
  // camera-locked label so the concept chip never leaves the frame during the push-in
  W.lockChip = el('div', 'chipc abs', stage, { display: 'none', height: '40px', fontSize: '22px', padding: '0 16px', transformOrigin: '0 0' }); W.lockChip.textContent = SB.workspace.conceptLabel || '';
  W.end = el('div', 'fill', stage, { display: 'none' });
  if (window.__buildFilm) window.__buildFilm({ SB, CREW, W, host: W.film, endHost: W.end, crewFile });
}
function buildRender(top, ui) {
  const r = el('div', 'btn abs', top, { left: RENDER.x + 'px', top: RENDER.y + 'px', width: RENDER.w + 'px', height: RENDER.h + 'px', justifyContent: 'center', background: INK, padding: '0', transformOrigin: '50% 50%', fontSize: '17px' }); W.render = r;
  // two labels: white on ink, ink on the highlight fill, clipped together so the word never disappears
  el('span', '', r, { color: '#fff' }).textContent = ui.render;
  W.renderFill = el('div', 'abs', r, { left: '0', top: '0', width: '100%', height: '100%', background: HL, display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK, clipPath: 'inset(0 100% 0 0)' });
  W.renderFill.textContent = ui.render;
  W.renderBite = el('div', 'abs', r, { left: '-16px', top: '-16px', width: '40px', height: '40px', borderRadius: '50%', background: 'var(--bg)', boxShadow: 'inset -2px -2px 0 rgba(0,0,0,.18)', display: 'none', zIndex: 3 });
}

// ---------- chat (left) ----------
function buildChat(world, ui) {
  const p = el('div', 'panel', world, { left: CH.x + 'px', top: CH.y + 'px', width: CH.w + 'px', height: CH.h + 'px' }); W.ch = p;
  el('div', 'abs', p, { left: '22px', top: '16px', font: '700 22px var(--ui)', whiteSpace: 'nowrap', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }).textContent = SB.workspace.channel;
  const on = el('div', 'abs', p, { left: '22px', top: '50px', font: '500 16px var(--ui)', color: '#6d6a63', display: 'flex', alignItems: 'center', gap: '7px' }); on.innerHTML = `<i style="width:9px;height:9px;border-radius:50%;background:#2fb96b;display:block"></i>${esc(ui.online)}`;
  el('div', 'abs', p, { left: '0', right: '0', top: '84px', height: '1px', background: '#ece8df' });
  W.stack = {};
  ['c5', 'c4', 'c1', 'c3', 'c2'].forEach((id, i) => { const x = CH.w - 22 - 40 - (4 - i) * 30; const a = img(p, crewFile(CREW[id]), { left: x + 'px', top: '20px', width: '40px', height: '40px', zIndex: 10 - i }); W.stack[id] = { a, wx: CH.x + x + 20, wy: CH.y + 40 }; });
  const box = el('div', 'abs', p, { left: '0', right: '0', top: '86px', bottom: '78px', overflow: 'hidden' });
  const list = el('div', 'abs', box, { left: '18px', right: '18px', top: '14px' });
  const comp = el('div', 'abs', p, { left: '16px', right: '16px', top: 'auto', bottom: '16px', height: '50px', borderRadius: '25px', background: '#fff', boxShadow: '0 0 0 1px #e3ded3', display: 'flex', alignItems: 'center', padding: '0 8px 0 20px', gap: '10px', font: '500 18px var(--ui)', color: '#9c9a93' });
  el('span', '', comp, { flex: '1' }).textContent = ui.composer;
  const send = el('div', '', comp, { width: '36px', height: '36px', borderRadius: '50%', background: INK, display: 'flex', alignItems: 'center', justifyContent: 'center' }); send.innerHTML = icon('arrow-up', 20, '#fff', 2.4);
  const msgs = CHAT.map(([slot, beat, from, typing]) => {
    const m = SB.chat[slot] || {}; const me = from === 'human'; const c = CREW[from];
    const node = el('div', 'msg' + (me ? ' me' : ''), list);
    const who = el('div', 'who', node, me ? {} : { color: c.color });
    el('span', '', who).textContent = me ? SB.human.name : c.name;
    el('span', 'role', who, { background: me ? INK : c.color }).textContent = me ? SB.human.role : c.role;
    const row = el('div', 'row', node); if (!me) img(row, crewFile(c), {}, 'av');
    const bub = el('div', 'bub', row); bub.innerHTML = `<span>${esc(m.text)}</span>` + (m.icon ? icon(m.icon, 22, me ? '#fff' : '#6d6b66', 2) : '');
    const trow = el('div', 'row', node, { display: 'none' }); if (!me) img(trow, crewFile(c), {}, 'av');
    const tb = el('div', 'bub', trow); tb.innerHTML = '<span class="dots3"><i></i><i></i><i></i></span>';
    return { m, me, node, row, trow, tb, at: beat, from: beat - typing };
  });
  W.chat = { box, list, msgs };
}
function measureChat() {
  // balance two-line bubbles, then shrink each bubble to its longest line so no lone word hangs on line two
  for (const x of W.chat.msgs) { x.node.style.display = 'block'; x.row.style.display = 'flex'; x.trow.style.display = 'none';
    const sp = x.row.querySelector('.bub > span'); sp.style.textWrap = 'balance';
    const f = sp.getBoundingClientRect().width / (sp.offsetWidth || 1), r = document.createRange(); r.selectNodeContents(sp);
    const q = [...r.getClientRects()]; if (q.length > 1 && f > 0) sp.style.width = Math.ceil((Math.max(...q.map(o => o.right)) - Math.min(...q.map(o => o.left))) / f + 1) + 'px';
    if (q.length > 2) console.warn(`chat line wraps to ${q.length} lines, keep it shorter: "${x.m.text}"`);
    x.node.style.display = 'none'; }
  for (const x of W.chat.msgs) { x.node.style.display = 'block'; x.row.style.display = 'flex'; x.trow.style.display = 'none'; x.hShown = x.node.offsetHeight + 14; x.row.style.display = 'none'; x.trow.style.display = 'flex'; x.hTyping = x.node.offsetHeight + 14; x.node.style.display = 'none'; }
  W.chat.boxH = W.chat.box.clientHeight - 28;
}
function updateChat(b) {
  if (!W.chat.boxH) measureChat();
  let H = 0, lastH = 0, lastAt = -99;
  for (const x of W.chat.msgs) {
    const shown = b >= x.at, typing = !shown && b >= x.from;
    x.node.style.display = shown || typing ? 'block' : 'none';
    x.row.style.display = shown ? 'flex' : 'none'; x.trow.style.display = typing ? 'flex' : 'none';
    if (typing) x.tb.querySelectorAll('i').forEach((d, j) => { const k = (b - x.from) * 2.2 - j * .3; d.style.transform = `translateY(${Math.sin(k * Math.PI) * -3}px)`; });
    if (shown) { const k = eBack((b - x.at) / .6); x.row.style.transform = `translateY(${(1 - k) * 14}px) scale(${lerp(.9, 1, k)})`; x.row.style.transformOrigin = x.me ? '100% 100%' : '0% 100%'; }
    if (shown || typing) { const h = shown ? x.hShown : x.hTyping; H += h; const since = shown ? x.at : x.from; if (since >= lastAt) { lastAt = since; lastH = h; } }
  }
  const target = Math.max(0, H - W.chat.boxH), k = eOut((b - lastAt) / .5);
  W.chat.list.style.transform = `translateY(${-Math.max(0, target - (1 - k) * Math.min(lastH, target))}px)`;
}

// ---------- assets gutter (narrow; clip icons, two thumbnails and the hype sticker) ----------
let CARRY_STYLE = null;
function buildAssets(world) {
  const p = el('div', 'panel', world, { left: AS.x + 'px', top: AS.y + 'px', width: AS.w + 'px', height: AS.h + 'px' }); W.assets = p;
  const hd = el('div', 'abs', p, { left: '0', width: '72px', top: '12px', textAlign: 'center' }); hd.innerHTML = icon('folder', 22, '#8a867d', 2);
  const motion = [tint(CREW.c4.color), deep(CREW.c4.color)], audio = [tint(CREW.c5.color), deep(CREW.c5.color)], titles = [HL, INK];
  CARRY_STYLE = { logo_rise: motion, logo_strip: motion, hero_line: titles, music: audio };
  const tiles = [['logo_rise', ...motion, 'sparkles'], ['hero_line', ...titles, 'type'], ['music', ...audio, 'music'], ['logo_strip', ...motion, 'film'], ['sfx', ...audio, 'check']];
  tiles.forEach(([k, bg, fg, ic]) => { const [x, y] = GUT(k); const t = el('div', 'abs', p, { left: x - AS.x - 24 + 'px', top: y - AS.y - 24 + 'px', width: '48px', height: '48px', borderRadius: '12px', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }); t.innerHTML = icon(ic, 24, fg, 2.2); });
  SB.media.gutter.slice(0, 2).forEach((f, i) => { const c = el('div', 'card', p, { left: '10px', top: 370 + i * 62 + 'px', width: '52px', height: '52px', borderRadius: '10px' }); img(c, f, { position: 'static' }, ''); });
  W.stickerHome = [AS.x + AS.w / 2, AS.y + 610];
}

// ---------- preview ----------
function buildPreview(world, ui) {
  const p = el('div', 'panel', world, { left: PV.x + 'px', top: PV.y + 'px', width: PV.w + 'px', height: PV.h + 'px' }); W.pv = p;
  W.play = el('div', 'btn abs', p, { left: PLAY.x - PV.x + 'px', top: PLAY.y - PV.y + 'px', height: PLAY.h + 'px', background: INK, color: '#fff', fontSize: '16px' });
  W.tag = el('div', 'tag abs', p, { left: '128px', top: '10px', height: '32px', fontSize: '16px' });
  const pl = el('div', 'plabel abs', p, { left: 'auto', right: '18px', top: '16px', fontSize: '17px', color: '#8a867d' }); pl.textContent = ui.preview;
  const chip2 = el('div', 'chipc abs', p, { left: '400px', top: '6px', height: '40px', fontSize: '22px', padding: '0 16px', display: SB.workspace.conceptLabel ? 'inline-flex' : 'none' }); chip2.textContent = SB.workspace.conceptLabel || ''; W.chip2 = chip2;
  const cv = el('div', 'abs', p, { left: CV.x - PV.x + 'px', top: CV.y - PV.y + 'px', width: CV.w + 'px', height: CV.h + 'px', overflow: 'hidden', background: 'var(--bg)', borderTop: '1px solid #e3ded3' }); W.cv = cv;
  W.film = el('div', 'film', cv, { transform: `scale(${FS})` });
  const dz = el('div', 'abs', cv, { left: '40px', top: '40px', right: '40px', bottom: '40px', border: '3px dashed #cfc8ba', borderRadius: '18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', color: '#8a867d', font: '600 28px var(--ui)', background: '#f7f5ef' });
  dz.innerHTML = `${icon('film', 52, '#b3ac9e', 1.6)}<span>${esc(ui.dropZone)}</span>`; W.dz = dz;
}

// ---------- timeline ----------
function buildTimeline(world, ui) {
  const p = el('div', 'panel', world, { left: TL.x + 'px', top: TL.y + 'px', width: TL.w + 'px', height: TL.h + 'px' }); W.tl = p;
  el('div', 'plabel abs', p, { left: '12px', top: '2px', fontSize: '16px', color: '#8a867d' }).textContent = ui.timeline;
  // ruler in seconds of the film-in-film (48 beats)
  const span = 48 * BEAT, step = span > 30 ? 8 : 4;
  for (let s = 0; s <= span + .01; s += step) { const t = el('div', 'abs', p, { left: lx(s / BEAT) - TL.x - (s ? 14 : 0) + 'px', top: '3px', font: '500 14px var(--mono)', color: '#8f8a7f' }); t.textContent = `0:${String(Math.round(s)).padStart(2, '0')}`; }
  W.lanes = ui.tracks.map((tr, i) => { const y = LANE_TOP + i * LANE_STEP - TL.y;
    el('div', 'lname', p, { left: '12px', top: y + 8 + 'px' }).textContent = tr;
    return el('div', 'lane', p, { left: LX0 - TL.x + 'px', top: y + 'px', width: LW + 'px' }); });
  W.head = el('div', 'playhead', p, { top: LANE_TOP - TL.y - 4 + 'px', height: 5 * LANE_STEP + 'px', zIndex: 5 });
}

// ---------- pointers ----------
const ARROW = (c, stroke = '#fff') => `<svg viewBox="0 0 28 28" width="34" height="34"><path d="M6 3.5 L6 22.5 L10.6 18.2 L13.6 25 L17 23.5 L14 16.9 L20.3 16.9 Z" fill="${c}" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
function buildPointers() {
  // the sticker and its strike sit under the pointers so the fact-checker stays visible
  W.sticker = el('div', 'abs', W.overlay, { padding: '10px 16px', borderRadius: '12px', background: '#ff4fa3', color: '#fff', font: '800 20px var(--ui)', whiteSpace: 'nowrap', boxShadow: '0 0 0 4px #fff, 0 14px 28px -10px rgba(0,0,0,.4)', transformOrigin: '50% 50%' });
  W.sticker.innerHTML = esc(SB.workspace.sticker).replace(/(!+)$/, '<span style="text-combine-upright:all">$1</span>');
  W.strike = el('div', 'abs', W.overlay, { height: '10px', borderRadius: '5px', background: CREW.c2.color, transformOrigin: '0 50%', display: 'none' });
  W.splats = [...Array(12)].map((_, i) => el('div', 'abs', W.overlay, { width: 10 + (i * 7) % 14 + 'px', height: 8 + (i * 5) % 12 + 'px', borderRadius: '50% 40% 55% 45%', background: CREW.c2.color, display: 'none' }));
  W.ptr = {};
  for (const c of SB.crew) {
    const n = el('div', 'ptr', W.overlay); const a = el('div', 'arrow', n); a.innerHTML = ARROW(c.color);
    const r = img(n, crewFile(c), {}, 'rider'); const t = el('div', 'ntag', n, { background: c.color, fontSize: '15px' }); t.textContent = c.name;
    const carry = el('div', 'abs', n, { display: 'none', left: '30px', top: '-36px', padding: '6px 11px', borderRadius: '8px', font: '600 15px var(--ui)', whiteSpace: 'nowrap', boxShadow: '0 10px 22px -8px rgba(0,0,0,.35)', transformOrigin: '0 100%' });
    W.ptr[c.id] = { n, a, r, t, carry };
  }
  const n = el('div', 'ptr', W.overlay, { display: 'none' }); el('div', 'arrow', n).innerHTML = ARROW('#ffffff', INK);
  el('div', 'ntag', n, { background: INK, top: '34px', left: '24px', fontSize: '15px' }).textContent = SB.human.name; W.lin = { n };
  W.flyer = img(W.overlay, crewFile(CREW.c4), { width: '50px', height: '50px', display: 'none', transformOrigin: '50% 50%' });
}
function path(kfs, b) {
  if (b <= kfs[0][0]) return [kfs[0][1], kfs[0][2], false];
  for (let i = 0; i < kfs.length - 1; i++) { const [b0, x0, y0] = kfs[i], [b1, x1, y1] = kfs[i + 1];
    if (b >= b0 && b < b1) { const k = eInOut((b - b0) / (b1 - b0)); return [lerp(x0, x1, k), lerp(y0, y1, k), x0 !== x1 || y0 !== y1]; } }
  const l = kfs[kfs.length - 1]; return [l[1], l[2], false];
}
const SHOTS0 = [[0, 8], [8, 16], [16, 24], [24, 36], [36, 44]], SHOTS1 = [[0, 8], [8, 20], [20, 28], [28, 40], [40, 48]];
const shotSpan = (i, b) => { const k = eInOut((b - 23) / .75); return [lerp(SHOTS0[i][0], SHOTS1[i][0], k), lerp(SHOTS0[i][1], SHOTS1[i][1], k)]; };
const STK = 1716;                          // where the human's sticker lands on shot 05 (kept inside the 1.04 drift)
const HOP = { c5: 3.25, c4: 3.5, c1: 3.75, c3: 4.0, c2: 4.25 };           // landing beats, one per quarter beat after the camera eases out
let CHO = null;
function choreo() {
  // homes keep every docked avatar and tag off the clips, the keyframe diamonds and each other
  const H = { c1: [1450, 26], c2: [1520, 900], c3: [1060, 900], c4: [1400, 946], c5: [866, 896] };
  const H5 = [1660, 912], DOCK5 = [1580, 30];   // the audio crew's later timeline home and top-bar spot after the nibble
  const LAND = { c5: [700, 300], c4: [700, 200], c1: H.c1, c3: H.c3, c2: [700, 250] };
  const R = [RENDER.x + 10, RENDER.y + 8], P = [PLAY.x + 24, PLAY.y + 18], s5 = STK;
  const BELOW = [585, 905];                 // waypoint under the canvas: trips to the gutter never cross the film
  const K = {
    c1: [[HOP.c1, ...H.c1], [6.6, ...H.c1], [7.4, ...P], [7.8, ...P], [8.8, ...H.c1], [55.0, ...H.c1], [55.5, RENDER.x + 18, RENDER.y + 34], [55.62, RENDER.x + 18, RENDER.y + 26], [55.75, RENDER.x + 18, RENDER.y + 34], [55.87, RENDER.x + 18, RENDER.y + 26], [56.0, RENDER.x + 18, RENDER.y + 34], [56.5, ...H.c1]],
    c2: [[HOP.c2, ...LAND.c2], [4.6, ...LAND.c2], [4.95, ...GUT('hero_line')], [5.45, lx(3), LY[1]], [6.2, ...H.c2], [47.0, ...H.c2], [47.45, s5 - 82, LY[0] - 34], [47.85, s5 + 78, LY[0] + 26], [48.25, ...H.c2], [53.0, ...H.c2], [53.45, lx(4), LY[1] - 4], [53.8, lx(4), LY[1] - 4], [54.6, ...H.c2]],
    c3: [[HOP.c3, ...H.c3], [5.2, ...H.c3], [5.5, lx(4), LY[0]], [6, lx(12), LY[0]], [6.5, lx(20), LY[0]], [7, lx(30), LY[0]], [7.5, lx(40), LY[0]], [8.6, ...H.c3], [15.2, ...H.c3], [15.5, lx(12), LY[0]], [16.3, ...H.c3], [22.6, ...H.c3], [23, lx(16) - 2, LY[0]], [23.75, lx(20) - 2, LY[0]], [24.6, ...H.c3]],
    c4: [[HOP.c4, ...LAND.c4], [4.0, ...LAND.c4], [4.3, ...GUT('logo_rise')], [4.75, lx(2), LY[2]], [5.4, ...H.c4], [20.6, ...H.c4], [21, lx(13), LY[2]], [22, lx(14), LY[2]], [23, lx(15), LY[2]], [24, lx(16), LY[2]], [25, ...H.c4],
         [26.3, ...H.c4], [26.8, ...BELOW], [27.25, ...GUT('logo_strip')], [27.7, ...BELOW], [28.3, lx(24), LY[2]], [29, ...H.c4]],
    c5: [[HOP.c5, ...LAND.c5], [6.1, ...LAND.c5], [6.55, ...GUT('music')], [7.05, lx(2), LY[3]], [7.8, ...H.c5], [12.2, ...H.c5], [12.65, lx(4.75) + 6, LY[3] - 20], [12.95, lx(4.75) + 6, LY[3] - 20], [13.25, lx(4.75) + 64, LY[3] - 30], [14.2, lx(4.75) + 64, LY[3] - 30],
         [14.5, 840, 828], [14.95, H5[0], 828], [15.25, ...H5],          // along the timeline's top edge, above everyone's avatars
         [40.6, ...H5], [41.0, lx(34.5), LY[4] - 6], [41.25, lx(35.5), LY[4] - 6], [41.5, lx(36.5), LY[4] - 6], [42.3, ...H5],
         [54.3, ...H5], [54.7, 1830, 840], [55.7, 1830, 150], [56.0, 1830, 150],   // waits in the right margin below the director's taps
         [56.35, R[0] - 4, R[1] + 4], [56.95, R[0] - 4, R[1] + 4], [57.5, ...DOCK5]],
  };
  const carry = { c2: [[4.95, 5.45, 'hero_line', 1.5]], c4: [[4.3, 4.75, 'logo_rise', 1], [27.6, 28.4, 'logo_strip', 1]], c5: [[6.55, 7.05, 'music', 1]] };
  return { K, carry, H, LAND, H5 };
}
function updatePointers(b) {
  if (!CHO) CHO = choreo();
  // at the push-in the five pointers scatter in five directions (up, up-right, right, down-left, left), staggered
  const off = { c1: [-80, -320, 0], c5: [520, -260, 1], c2: [680, 40, 2], c4: [-240, 460, 3], c3: [-700, 60, 4] };
  for (const c of SB.crew) {
    const P = W.ptr[c.id]; const land = HOP[c.id];
    let [x, y, moving] = path(CHO.K[c.id], b);
    const by = y;                                  // path height before the idle bob decides the rider's side
    if (!moving && b > land + .3 && b < 65.6) { const i = SB.crew.indexOf(c); x += Math.sin(b * .9 + i * 1.7) * 5; y += Math.cos(b * .7 + i) * 4; }
    const st = W.stack[c.id], flyK = clamp((b - (land - .6)) / .6);
    st.a.style.opacity = b < land - .6 ? 1 : 0;
    let rx = 0, ry = 0, rs = 1, rot = 0, sq = 1;
    // x leads the hop so the arc rises clear of the top-bar concept chip
    if (b < land) { const hx = lerp(st.wx, x + 37, eOut(flyK)), hy = lerp(st.wy, y + 37, eInOut(flyK)) - Math.sin(Math.PI * flyK) * 150; rx = hx - (x + 37); ry = hy - (y + 37); rs = lerp(.8, 1.35, Math.sin(Math.PI * flyK)); }
    sq = 1 - spring((b - land) * BEAT, .24, 8, 22);
    if (c.id === 'c1') ry -= Math.max(0, Math.sin(Math.PI * clamp((b - 23.75) / .6))) * 30;
    { const k = clamp((b - 62) / .7); ry -= Math.max(0, Math.sin(Math.PI * k)) * (by < 100 ? 28 : 46); if (b >= 62.7) sq *= 1 - spring((b - 62.7) * BEAT, .22, 9, 24); }
    if (c.id === 'c5') {
      rot += -8 * Math.sin(Math.PI * clamp((b - 6.5) / .8));
      if (b >= 13.5) rot += 10 * Math.sin((b - 13.5) * 18) * clamp(1 - (b - 13.5) / .8);
      if (b >= 12.5 && b < 13.1) { const k = Math.sin(Math.PI * clamp((b - 12.5) / .6)); ry += k * 26; sq *= 1 - k * .22; rot += k * 16; }
      if (b >= 56.25 && b < 56.95) { const k = Math.sin(Math.PI * clamp((b - 56.25) / .7)); ry += k * 16; sq *= 1 - k * .2; rot += k * 14; }
      if (b >= 57 && b < 61) rot += Math.sin(b * 9) * 4;
      if (b >= 51.5 && b < 53.5) rot += -12;
      if (b >= 55.6 && b < 56.3) rot += Math.sin(b * 20) * 8;
    }
    let riderShown = b >= land - .6, bright = 1, scale = 1;
    if (c.id === 'c4') {
      if (b >= 33.4 && b < 36) riderShown = false;
      if (b >= 36 && b < 41) { bright = .6; scale = .9; }
      if (b >= 41 && b < 41.6) { const k = eOut((b - 41) / .6); bright = lerp(.6, 1, k); scale = lerp(.9, 1, k); }
    }
    let alpha = 1;
    { const [dx, dy, i] = off[c.id], at = 65.6 + i * .06, k = Math.pow(clamp((b - at) / .55), 2);
      if (b >= at) { const pull = Math.sin(Math.PI * clamp((b - at) / .2)) * .04; x += dx * (k - pull); y += dy * (k - pull); rot += Math.sign(dx || 1) * 24 * k; alpha = 1 - clamp((b - at - .38) / .17); } }
    P.n.style.transform = `translate(${x}px, ${y}px)`; P.n.style.opacity = alpha;
    P.a.style.opacity = b < land - .05 ? 0 : 1; P.t.style.opacity = b < land ? 0 : 1;
    P.r.style.display = riderShown ? 'block' : 'none';
    P.r.style.filter = bright < 1 ? `brightness(${bright})` : 'none';
    // rider sits below-right of the tip; near the bottom edge it eases above the tip (from the path height, so the
    // idle bob can never toggle it) and during the strike the fact-checker rides high above the sticker. Tags follow the rider.
    const fk = b >= land ? eInOut(clamp((by - 990) / 24)) : 0;
    const k2 = c.id === 'c2' ? eInOut(clamp((b - 47.0) / .3)) * (1 - eInOut(clamp((b - 48.25) / .3))) : 0;
    const ox = lerp(0, -90, k2), oy = lerp(-60 * fk, -125, k2), side = Math.max(fk, k2);
    P.r.style.left = 12 + ox + 'px'; P.r.style.top = 12 + oy + 'px';
    P.t.style.left = lerp(20, 12 + ox + 56, side) + 'px'; P.t.style.top = lerp(60, 12 + oy + 16, side) + 'px';
    P.r.style.transform = `translate(${rx}px, ${ry}px) rotate(${rot}deg) scale(${rs * scale * (2 - sq)}, ${rs * scale * sq})`;
    const cr = (CHO.carry[c.id] || []).find(([b0, b1]) => b >= b0 && b < b1);
    if (cr) { const [bg, fg] = CARRY_STYLE[cr[2]]; P.carry.style.display = 'block'; P.carry.style.background = bg; P.carry.style.color = fg; P.carry.textContent = SB.ui.clips[cr[2]]; P.carry.style.transform = `scale(${cr[3]})`; }
    else P.carry.style.display = 'none';
  }
  // the animator's flight into the film and back out (the film's only crossing)
  const f = W.flyer, slot = toWorld(1515, 495), hp = path(CHO.K.c4, b), big = 230 * FS / 50;
  if (b >= 33.4 && b < 34) { const k = clamp((b - 33.4) / .6); const e = 1 - Math.pow(1 - k, 2); const x = lerp(hp[0] + 37, slot[0], e), y = lerp(hp[1] + 37, slot[1], e) - Math.sin(Math.PI * k) * 150;
    f.style.display = 'block'; f.style.transform = `translate(${x - 25}px, ${y - 25}px) scale(${lerp(1, big, eInOut(k))}) rotate(${Math.sin(Math.PI * k) * -12}deg)`; }
  else if (b >= 35.3 && b < 36) { const k = clamp((b - 35.3) / .7); const x = lerp(slot[0], hp[0] + 37, eInOut(k)), y = lerp(CV.y + CV.h + 10, hp[1] + 37, eIn(k));
    f.style.display = 'block'; f.style.transform = `translate(${x - 25}px, ${y - 25}px) scale(${lerp(big * .7, 1, k)}) rotate(${(1 - k) * 30}deg)`; }
  else f.style.display = 'none';
  // the human's pointer and the hype sticker
  const s5 = STK, BELOW2 = [640, 860];
  const LK = [[43.0, CH.x + CH.w + 4, 700], [44.0, W.stickerHome[0] + 8, W.stickerHome[1] + 8], [44.25, BELOW2[0], BELOW2[1]], [44.5, s5 + 10, LY[0] + 4], [44.9, s5 - 260, LY[0] + 40], [49.5, s5 - 260, LY[0] + 40], [50.3, CH.x + CH.w + 4, 760]];
  const lp = path(LK, b);
  W.lin.n.style.display = b >= 43.0 && b < 50.3 ? 'block' : 'none'; W.lin.n.style.transform = `translate(${lp[0]}px, ${lp[1]}px)`;
  const s = W.sticker, V = !!SB.cjk; let sx, sy, ss = 1, so = 1, sr = V ? 0 : -90;
  s.style.writingMode = V && b < 44 ? 'vertical-rl' : 'horizontal-tb'; s.style.textOrientation = 'upright';
  if (b < 44) { [sx, sy] = W.stickerHome; ss = .72; }
  else if (b < 44.5) { const k = eInOut((b - 44) / .5); const pp = path([[44, ...W.stickerHome], [44.25, BELOW2[0] - 8, BELOW2[1] - 8], [44.5, s5, LY[0] - 6]], b); sx = pp[0]; sy = pp[1]; ss = lerp(1.1, 1.5, Math.sin(Math.PI * k)); sr = lerp(V ? 0 : -90, -6, k); }
  else { sx = s5; sy = LY[0] - 6; ss = 1.2 - spring((b - 44.5) * BEAT, .15, 8, 22); sr = -6; }
  if (b >= 48) { const k = clamp((b - 48) / .4); ss *= 1 + k * .4; so = 1 - k; }
  s.style.display = b >= 48.4 || b >= 66 ? 'none' : 'block';
  const sw = s.offsetWidth || 180, shh = s.offsetHeight || 44;
  s.style.transform = `translate(${sx - sw / 2}px, ${sy - shh / 2}px) rotate(${sr}deg) scale(${ss})`; s.style.opacity = so;
  const st = W.strike, x0 = s5 - 82, y0 = LY[0] - 34, x1 = s5 + 78, y1 = LY[0] + 26, len = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
  st.style.display = b >= 47.45 && b < 48.15 ? 'block' : 'none'; st.style.width = len + 'px'; st.style.transform = `translate(${x0}px, ${y0 - 5}px) rotate(${ang}deg) scaleX(${eOut((b - 47.45) / .4)})`;
  W.splats.forEach((d, i) => { const k = clamp((b - 48) / .9); const a = i / W.splats.length * Math.PI * 2 + i * .7; const r = 60 + (i * 37) % 70;
    d.style.display = b >= 48 && b < 48.9 ? 'block' : 'none'; d.style.transform = `translate(${sx + Math.cos(a) * r * eOut(k)}px, ${sy + Math.sin(a) * r * .7 * eOut(k) + eIn(k) * 30}px) rotate(${i * 40}deg) scale(${1 - k * .6})`; d.style.opacity = 1 - eIn(k); });
}

// ---------- timeline state ----------
let TLB = null;
function buildClips() {
  const ui = SB.ui, lane = W.lanes, motion = CARRY_STYLE.logo_rise, audio = CARRY_STYLE.music;
  const clip = (li, cls, css) => el('div', 'clip ' + cls, lane[li], css);
  TLB = {};
  TLB.logoRise = clip(2, '', { left: '0px', width: lx(4) - LX0 - 4 + 'px', background: motion[0], color: motion[1] }); TLB.logoRise.textContent = ui.clips.logo_rise;
  TLB.hero = clip(1, '', { left: '0px', width: lx(8) - LX0 - 4 + 'px', background: HL }); TLB.hero.textContent = ui.clips.hero_line;
  TLB.shots = ui.shotClips.map((name, i) => { const c = clip(0, 'ph', {}); const th = img(c, SB.media.thumbs[i % SB.media.thumbs.length], { position: 'static', display: 'none' }, 'th'); el('span', '', c).textContent = name; return { c, th }; });
  TLB.music = clip(3, '', { left: '0px', width: LW - 2 + 'px', background: audio[0], color: audio[1], padding: '0', overflow: 'visible' });
  const wf = el('div', 'abs', TLB.music, { left: '0', top: '0', right: '0', bottom: '0' });
  TLB.bars = []; const n = 220;
  for (let i = 0; i < n; i++) { const fb = i / n * 48; const h = 5 + Math.abs(Math.sin(i * 1.3) * Math.cos(i * .41)) * 16 + (i % 8 === 0 ? 4 : 0);
    TLB.bars.push({ e: el('i', '', wf, { position: 'absolute', left: i / n * 100 + '%', top: (28 - h) / 2 + 'px', width: '2.5px', height: h + 'px', borderRadius: '2px', background: CREW.c5.color, opacity: .7 }), fb, h }); }
  const lbl = el('div', 'abs', TLB.music, { left: 'auto', right: '8px', top: '4px', font: '600 16px var(--ui)', background: audio[0], padding: '0 5px', borderRadius: '4px' }); lbl.textContent = ui.clips.music;
  // the bite: a semicircle out of the clip's top edge with a darker rim and crumbs
  TLB.bite = el('div', 'abs', TLB.music, { left: lx(4.75) - LX0 - 36 + 'px', top: '-22px', width: '72px', height: '44px', display: 'none' });
  [[0, 16], [22, 22], [44, 16]].forEach(([dx, dy]) => el('div', 'abs', TLB.bite, { left: dx + 'px', top: dy - 14 + 'px', width: '30px', height: '30px', borderRadius: '50%', background: '#f4f1ea', boxShadow: `inset 0 -4px 0 ${deep(CREW.c5.color)}` }));
  TLB.chunk = el('div', 'abs', W.lanes[3], { width: '34px', height: '16px', borderRadius: '8px 8px 4px 4px', background: mix(CREW.c5.color, '#ffffff', .5), boxShadow: `inset 0 0 0 2px ${audio[1]}`, display: 'none', left: lx(4.75) - LX0 - 17 + 'px', top: '-4px' });
  TLB.crumbs = [...Array(6)].map(() => el('div', 'abs', lane[3], { width: '6px', height: '6px', borderRadius: '2px', background: CREW.c5.color, display: 'none', left: lx(4.75) - LX0 + 'px', top: '0px' }));
  TLB.diamonds = [13, 14, 15, 16].map(fb => el('div', 'diamond', lane[2], { left: lx(fb) - LX0 - 8 + 'px', top: '9px', background: CREW.c4.color }));
  TLB.strip = clip(2, '', { left: lx(20) - LX0 + 'px', width: lx(28) - lx(20) - 4 + 'px', background: motion[0], color: motion[1] }); TLB.strip.textContent = ui.clips.logo_strip;
  TLB.sfxLbl = clip(4, '', { left: lx(37.3) - LX0 + 'px', background: audio[0], color: audio[1] }); TLB.sfxLbl.textContent = ui.clips.sfx;
  TLB.ticks = [34.5, 35.5, 36.5].map(fb => { const c = clip(4, '', { left: lx(fb) - LX0 - 15 + 'px', width: '30px', background: audio[0], padding: '0', justifyContent: 'center' }); c.innerHTML = icon('check', 16, audio[1], 3); return c; });
}
function pop(elm, b, at, dur = .5, fromScale = .4) { const k = eBack((b - at) / dur); elm.style.display = b >= at ? '' : 'none'; elm.style.transform = `scale(${lerp(fromScale, 1, k)})`; elm.style.opacity = clamp((b - at) / .15); }
function updateTimeline(b) {
  if (!TLB) buildClips();
  pop(TLB.logoRise, b, 4.75); pop(TLB.hero, b, 5.45);
  TLB.hero.style.boxShadow = b >= 53.4 && b < 54.2 ? `0 0 0 3px ${INK}` : '';
  TLB.shots.forEach(({ c, th }, i) => {
    const [a, e] = shotSpan(i, b); c.style.left = lx(a) - LX0 + 'px'; c.style.width = lx(e) - lx(a) - 4 + 'px';
    pop(c, b, 5.5 + i * .5, .45, .6);
    const isReal = b >= [8, 15.5, 28, 36, 48][i];
    c.className = 'clip ' + (isReal ? 'shot' : 'ph'); th.style.display = isReal ? 'block' : 'none';
    const fb = b - 8, playing = b >= 8 && b < 56 && fb >= a && fb < e;
    c.style.boxShadow = playing ? `0 0 0 2px ${INK} inset` : '';
    if (i === 1 && b >= 22.6 && b < 24) c.style.boxShadow = `0 0 0 2px ${HL}, 0 0 14px ${HL}`;
  });
  TLB.music.style.display = b >= 7 ? 'block' : 'none';
  TLB.music.style.clipPath = `inset(-30px ${100 - eOut((b - 7) / 2) * 100}% 0 0)`;
  const bitten = b >= 12.75;
  TLB.bite.style.display = bitten ? 'block' : 'none';
  for (const o of TLB.bars) { const flat = bitten && o.fb >= 4.75 && o.fb < 6.5; o.e.style.height = (flat ? 2 : o.h) + 'px'; o.e.style.top = (28 - (flat ? 2 : o.h)) / 2 + 'px'; }
  { const k = clamp((b - 12.75) / .8); TLB.chunk.style.display = b >= 12.75 && b < 13.55 ? 'block' : 'none'; TLB.chunk.style.transform = `translate(${-40 * eOut(k)}px, ${-70 * Math.sin(Math.PI * k * .8) + 40 * k * k}px) rotate(${-60 * k}deg)`; }
  TLB.crumbs.forEach((d, i) => { const k = clamp((b - 12.75) / .9); d.style.display = b >= 12.75 && b < 13.65 ? 'block' : 'none'; d.style.transform = `translate(${(i - 2.5) * 12 * eOut(k)}px, ${-8 - Math.sin(Math.PI * k) * 26 + k * 30}px) rotate(${i * 50 * k}deg)`; });
  TLB.diamonds.forEach((d, i) => { const at = 21 + i; const k = eBack((b - at) / .4); d.style.display = b >= at ? 'block' : 'none'; d.style.transform = `rotate(45deg) scale(${lerp(.2, 1, k)})`; });
  pop(TLB.strip, b, 28.4); TLB.ticks.forEach((c, i) => pop(c, b, 41 + i * .25)); pop(TLB.sfxLbl, b, 42);
  let fb = clamp(b - 8, 0, 48);
  if (b >= 56 && b < 57) fb = 48; else if (b >= 57 && b < 61) fb = (b - 57) / 4 * 48; else if (b >= 61) fb = 48;
  W.head.style.left = lx(fb) - TL.x - 1 + 'px';
  // Render: nibbled at b56.5 (top-left corner), fills b57-61 with the label kept readable
  W.renderBite.style.display = b >= 56.5 ? 'block' : 'none';
  W.render.style.transform = `scale(${1 - (b >= 56.5 ? spring((b - 56.5) * BEAT, .14, 9, 26) : 0)})`;
  W.renderFill.style.clipPath = `inset(0 ${100 - clamp((b - 57) / 4) * 100}% 0 0)`;
  W.render.style.boxShadow = b >= 55.5 && b < 57 ? `0 0 0 4px ${HL}f2` : 'none';
}

// ---------- preview header ----------
function updatePreview(b, fbView) {
  W.dz.style.display = b < 8 ? 'flex' : 'none';
  W.film.style.display = b >= 8 ? 'block' : 'none';
  const playing = b >= 8 && b < 56;
  W.play.innerHTML = icon(playing ? 'pause' : 'play', 15, '#fff', 0) + `<span>${esc(SB.ui.play)}</span>`;
  W.play.style.transform = `scale(${b >= 7.5 && b < 7.8 ? .9 : 1})`;
  const starts = [8, 16, 28, 36, 48]; let idx = 0; for (let i = 0; i < 5; i++) if (fbView >= starts[i]) idx = i;
  W.tag.style.display = b >= 8 ? 'inline-flex' : 'none'; W.tag.textContent = SB.ui.sceneTags[idx];
  if (!W.titleX) {
    W.titleX = true;
    const wmRight = 66 + W.wm.measure();
    if (W.chip1) { W.chip1.style.left = wmRight + 18 + 'px'; W.title.style.left = W.chip1.offsetLeft + W.chip1.offsetWidth + 22 + 'px'; }
    else W.title.style.left = wmRight + 26 + 'px';
    if (W.title.offsetLeft + W.title.offsetWidth > 1630) console.warn('project title runs into the Share button; shorten workspace.projectTitle');
  }
}

// ---------- camera ----------
// Each segment zooms about the point both keyframes agree on, so the frame never lags or swims. Drifts are 1.6 % about
// the frame centre: that crops under 16 px per side, inside the panel margins, so the chat, both concept chips,
// Render and the timeline lanes all stay whole.
function camera(b) {
  const S = 1920 / CV.w, D = 1.016;
  const K = [
    [-2, 1.3, 960 / 1.3, 540 / 1.3], [2.4, 1.3, 960 / 1.3, 540 / 1.3], [4.3, 1, 960, 540],
    [22.5, 1, 960, 540], [23.4, D, 960, 540], [24.4, D, 960, 540], [25, 1, 960, 540],
    [46.4, 1, 960, 540], [47.2, D, 960, 540], [49.5, D, 960, 540], [50, 1, 960, 540],
    [61, 1, 960, 540], [65.6, D, 960, 540],
    [68, S, CV.x + CV.w / 2, CV.y + CV.h / 2], [99, S, CV.x + CV.w / 2, CV.y + CV.h / 2],
  ];
  let a = K[0], z = K[K.length - 1];
  for (let i = 0; i < K.length - 1; i++) if (b >= K[i][0] && b < K[i + 1][0]) { a = K[i]; z = K[i + 1]; break; }
  const k = eInOut((b - a[0]) / Math.max(.001, z[0] - a[0]));
  const s = Math.exp(lerp(Math.log(a[1]), Math.log(z[1]), k));
  let x, y;
  if (Math.abs(a[1] - z[1]) > 1e-6) {   // fixed point F: (F - cA) * sA == (F - cZ) * sZ
    const fx = (a[2] * a[1] - z[2] * z[1]) / (a[1] - z[1]), fy = (a[3] * a[1] - z[3] * z[1]) / (a[1] - z[1]);
    x = fx - (fx - a[2]) * a[1] / s; y = fy - (fy - a[3]) * a[1] / s;
  } else { x = lerp(a[2], z[2], k); y = lerp(a[3], z[3], k); }
  W.world.style.transform = `translate(${960 - x * s}px, ${540 - y * s}px) scale(${s})`;
  const o = b >= 66 ? eInOut((b - 66) / 2) : 0;
  W.ch.style.transform = `translateX(${-o * 560}px)`; W.tl.style.transform = `translateY(${o * 320}px)`; W.top.style.transform = `translateY(${-o * 100}px)`; W.assets.style.transform = `translateX(${-o * 640}px)`;
  // one concept chip hands off to a screen layer at its own on-screen spot and stays inside the frame
  const hand = b >= 66 && b < 68 && !!SB.workspace.conceptLabel;
  W.chip2.style.visibility = hand ? 'hidden' : 'visible';
  W.lockChip.style.display = hand ? 'inline-flex' : 'none';
  if (hand) { const wx = PV.x + 400, wy = PV.y + 6; let sx = 960 - x * s + wx * s, sy = 540 - y * s + wy * s; const cs = Math.min(s, 1.25);
    sx = clamp(sx, 16, 1920 - 16 - W.chip2.offsetWidth * cs); sy = clamp(sy, 16, 1080 - 60); W.lockChip.style.transform = `translate(${sx}px, ${sy}px) scale(${cs})`; }
  W.world.style.display = b >= 68 ? 'none' : 'block'; W.end.style.display = b >= 68 ? 'block' : 'none';
}

function update(t) {
  const b = bOf(t);
  let fbView = b;
  if (b >= 56 && b < 57) fbView = 56.2;
  else if (b >= 57 && b < 61) fbView = [12.8, 18.8, 25.6, 32.6, 37.2, 45.6, 53.4, 56.2][clamp(Math.floor((b - 57) * 2), 0, 7)];
  else if (b >= 61) fbView = 56.2;
  camera(b); updatePreview(b, fbView); updateTimeline(b); updateChat(b); updatePointers(b);
  if (window.__updateFilm) window.__updateFilm(b, fbView);
}
async function seek(t) {
  await ready;
  update(t);
  const p = pending.splice(0); await Promise.all(p);
  await new Promise(r => requestAnimationFrame(() => r()));
}
window.__film = { fps: FPS, duration: 40, scenes: [], ready, seek };
if (!/render=1/.test(location.search)) {
  // preview: fit the stage to the window, scrub with the bar, space plays and pauses
  const q = new URLSearchParams(location.search);
  const fit = () => { const s = Math.min(innerWidth / 1920, (innerHeight - 36) / 1080); stage.style.transformOrigin = '0 0'; stage.style.transform = `scale(${s})`; };
  addEventListener('resize', fit); fit();
  ready.then(() => {
    const bar = el('div', '', document.body); bar.id = 'bar';
    const btn = el('button', '', bar); const range = el('input', '', bar); range.type = 'range'; range.min = 0; range.max = DUR; range.step = 1 / FPS;
    const lbl = el('span', '', bar, { width: '120px', textAlign: 'right' });
    let playing = !q.has('t'), t = +(q.get('t') || 0), last = performance.now();
    const show = () => { btn.textContent = playing ? 'Pause' : 'Play'; range.value = t; lbl.textContent = `${t.toFixed(2)}s  b${bOf(t).toFixed(2)}`; };
    btn.onclick = () => { playing = !playing; last = performance.now(); show(); };
    range.oninput = () => { t = +range.value; playing = false; seek(t); show(); };
    addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); btn.onclick(); } if (e.code === 'ArrowRight') { t = Math.min(DUR, t + 1 / FPS); playing = false; seek(t); show(); } if (e.code === 'ArrowLeft') { t = Math.max(0, t - 1 / FPS); playing = false; seek(t); show(); } });
    const tick = () => { const now = performance.now(); if (playing) { t = (t + (now - last) / 1000) % DUR; } last = now; seek(t).then(() => { show(); requestAnimationFrame(tick); }); };
    seek(t).then(tick);
  });
}
})();
