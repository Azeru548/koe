// Film-in-film scenes (1920x1080 film space) and the native end card. Every update takes film beats b.
// The five scenes keep fixed beat windows (brand 8-16, what 16-28, fit 28-36, how 36-48, proof 48-56) because the
// workspace choreography around them (cursors, timeline clips, chat) is timed to the same grid.
(() => {
const { clamp, lerp, eOut, eIn, eInOut, eBack, spring, el, esc, icon, img, tile, wordmark } = window.__fx;
const INK_PTR = '<svg viewBox="0 0 28 28" width="64" height="64"><path d="M6 3.5 L6 22.5 L10.6 18.2 L13.6 25 L17 23.5 L14 16.9 L20.3 16.9 Z" fill="#121313" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
let SB, BEAT = .5, ZH = false, HL = '#f4ff71', INK = '#121313';
const sec = db => db * BEAT;                              // beats -> seconds (for springs)
const CJKC = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
// join two chunks with a half-width space where CJK meets Latin/digits (or always, in Latin scripts)
const gap = (a, b) => !ZH ? ' ' : ((CJKC.test(a.slice(-1)) && /^[A-Za-z0-9]/.test(b)) || (/[A-Za-z0-9.]$/.test(a) && CJKC.test(b[0])) ? ' ' : '');
const LAT = /[A-Za-z0-9][A-Za-z0-9 .'&+\-]*[A-Za-z0-9.]|[A-Za-z0-9]|[^A-Za-z0-9]+/g;
const warn = m => console.warn(m);

// ---------- shared pieces ----------
// headline line built from runs; runs = [{t, hl}] where hl marks the highlighter run
function line(parent, runs, css) {
  const box = el('div', 'fh', parent, css);
  const fill = (span, text) => { if (!ZH) { span.textContent = text; return; } for (const seg of text.match(LAT) || []) { const e = el('span', /[A-Za-z0-9]/.test(seg) ? 'lat' : '', span); e.textContent = seg; } };
  const spans = runs.map(r => { const s = el('span', 'word', box); fill(s, r.t); if (r.hl) { s.style.backgroundImage = `linear-gradient(${HL}, ${HL})`; s.style.backgroundRepeat = 'no-repeat'; s.style.backgroundPosition = '0 88%'; s.style.backgroundSize = '0% 46%'; s.hl = true; } return s; });
  box.spans = spans;
  box.hl = k => spans.forEach(s => { if (s.hl) s.style.backgroundSize = `${clamp(k) * 100}% 46%`; });
  box.fit = (maxW, base, label = '') => { box.style.fontSize = base + 'px'; const w = box.scrollWidth; if (w > maxW) { box.style.fontSize = base * maxW / w + 'px'; if (maxW / w < .72) warn(`headline "${box.textContent}" ${label} is long and was shrunk to ${Math.round(maxW / w * 100)}%; shorten it`); } };
  return box;
}
// split a chunk into runs, marking the highlighted word
function runs(text, hlWord) {
  if (!hlWord || !text.includes(hlWord)) return [{ t: text }];
  const i = text.indexOf(hlWord); const out = [];
  if (i > 0) out.push({ t: text.slice(0, i) }); out.push({ t: hlWord, hl: true }); if (i + hlWord.length < text.length) out.push({ t: text.slice(i + hlWord.length) });
  return out;
}
// text that may hold CJK and Latin: Latin runs use the display face inside CJK headlines
function mixed(node, text) {
  if (!ZH) { node.textContent = text; return; }
  for (const seg of text.match(LAT) || []) { const e = el('span', '', node); e.textContent = seg; if (/[A-Za-z0-9]/.test(seg)) Object.assign(e.style, { fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '-.02em' }); }
}
function slam(elm, b, at, base = '') { const k = clamp((b - at) / .25); const sq = b >= at ? 1 - spring(sec(b - at), .18, 9, 24) : 1;
  elm.style.opacity = b >= at ? 1 : 0; elm.style.transform = `${base} translateY(${(1 - eOut(k)) * -40}px) scale(${lerp(1.25, 1, eOut(k)) * (2 - sq)}, ${lerp(1.25, 1, eOut(k)) * sq})`; }
function rise(elm, b, at, dist = 50, dur = .5) { const k = eOut((b - at) / dur); elm.style.opacity = k; elm.style.transform = `translateY(${(1 - k) * dist}px)`; }
const pick = (arr, i) => arr[i % arr.length];
function fitText(node, maxW, base) { node.style.fontSize = base + 'px'; const w = node.scrollWidth; if (w > maxW) node.style.fontSize = base * maxW / w + 'px'; }

// ---------- Scene 1: brand ----------
function scene1(root, S) {
  const lock = el('div', 'abs', root, { width: '1920px', height: '1080px', transformOrigin: '960px 470px' });
  const T = tile(lock, 260, { left: '0', top: '0' });
  const wm = wordmark(lock, 210, { top: '0' });
  const [l1, l2] = S.headline; const hlIn1 = !!S.highlight && l1.includes(S.highlight);
  // line 1 enters in two halves (word by word in Latin scripts), line 2 slams on the next accent
  let h1;
  if (ZH) h1 = line(root, runs(l1, hlIn1 ? S.highlight : null), { top: '360px' });
  else { const w = l1.split(' '), cut = Math.max(1, Math.ceil(w.length / 2)); const a = w.slice(0, cut).join(' '), z = w.slice(cut).join(' ');
    h1 = line(root, z ? [{ t: a + ' ', hl: hlIn1 && a.includes(S.highlight) }, { t: z, hl: hlIn1 && z.includes(S.highlight) && !a.includes(S.highlight) }] : [{ t: a, hl: hlIn1 }], { top: '360px' }); }
  const h2 = line(root, runs(l2, hlIn1 ? null : S.highlight), { top: '510px' });
  const sub = el('div', 'fs', root, { top: '690px', left: '0', width: '1920px', textAlign: 'center' }); sub.textContent = S.sub || '';
  const peeks = [0, 1, 2, 3].map(i => { const c = el('div', 'card', root, { left: 150 + i * 420 + 'px', top: '1110px', width: '360px', height: '225px' }); img(c, pick(S.peeks, i), { position: 'static' }, ''); return c; });
  let meas = null;
  return b => {
    if (!meas) {
      h1.fit(1700, 128, '(brand line 1)'); h2.fit(1700, 128, '(brand line 2)'); [h1, h2].forEach(h => { h.style.left = (1920 - h.scrollWidth) / 2 + 'px'; });
      fitText(sub, 1700, 44);
      let w = wm.measure(); if (310 + w > 1760) { const k = (1760 - 310) / w; if (wm.style.fontSize) wm.style.fontSize = 210 * k + 'px'; else wm.style.height = 210 * k + 'px'; w = wm.measure(); }
      meas = { w, h: parseFloat(wm.style.fontSize || wm.style.height || 210) };
    }
    // tile drop and mark draw
    const dropK = clamp((b - 8) / .35), land = 8.35;
    let ty = lerp(-360, 470, eIn(dropK)), ts = b < land ? lerp(.6, 1, dropK) : 1 + (b < 8.5 ? .06 * Math.sin(Math.PI * (b - land) / .15) : 0);
    const sq = b >= land ? 1 - spring(sec(b - land), .2, 9, 22) : 1;
    T.draw(eOut((b - 8.5) / .5));
    // lockup: tile slides left, wordmark wipes in; then everything shrinks to top-center
    const g = 260 + 50 + meas.w, slideK = eInOut((b - 9.5) / .5);
    const tx0 = 960 - 130, tx1 = 960 - g / 2;
    const tileX = lerp(tx0, tx1, slideK);
    T.style.transform = `translate(${tileX}px, ${ty - 130}px) scale(${ts * (2 - sq)}, ${ts * sq})`;
    wm.style.left = tx1 + 310 + 'px'; wm.style.top = 470 - meas.h / 2 + 'px'; wm.style.clipPath = `inset(-20% ${100 - eOut((b - 9.5) / .5) * 100}% -20% 0)`;
    const shK = eInOut((b - 10.5) / .5);
    lock.style.transform = `translateY(${-shK * 300}px) scale(${lerp(1, .4, shK)})`;
    // headline: line 1 at b11 (and b11.5), line 2 slams on b12, the highlighter at b12.5
    if (ZH) rise(h1, b, 11, 50, .4); else h1.spans.forEach((s, i) => { const k = eOut((b - 11 - (i ? .5 : 0)) / .4); s.style.opacity = k; s.style.transform = `translateY(${(1 - k) * 50}px)`; });
    slam(h2, b, 12);
    h1.hl(eOut((b - 12.5) / .35)); h2.hl(eOut((b - 12.5) / .35));
    sub.style.opacity = clamp((b - 13) / .5);
    peeks.forEach((c, i) => { c.style.display = b >= 14.45 ? 'block' : 'none'; const k = eBack((b - 14.5 - i * .06) / .5); const wob = b >= 15 ? Math.sin((b - 15) * Math.PI * 2 + i) * 3 * clamp(1 - (b - 15) / 1.5) : 0; c.style.transform = `translateY(${-k * 280}px) rotate(${(i % 2 ? 2 : -2) + wob}deg)`; });
    const nudge = b >= 15.5 ? -8 * eOut((b - 15.5) / .3) : 0; root.style.transform = `translateY(${nudge}px)`;
  };
}

// ---------- Scene 2: what it is ----------
function scene2(root, S) {
  // part A: the product card with three facts
  const card = el('div', 'abs', root, { left: '580px', top: '400px', width: '760px', height: '420px', borderRadius: '34px', background: '#fff', boxShadow: `0 40px 80px -40px rgba(40,30,10,.45), 0 0 0 3px ${INK}`, transformOrigin: '50% 100%' });
  const ch = el('div', 'abs', card, { left: '40px', top: '36px', display: 'flex', alignItems: 'center', gap: '16px' });
  const mt = tile(ch, 56, { position: 'relative' }); mt.draw(1);
  const sk = el('div', 'mono', ch, { font: '700 26px var(--mono)', padding: '8px 14px', borderRadius: '10px', background: '#f1eee7', letterSpacing: '.1em', textTransform: 'uppercase' }); sk.textContent = S.kind;
  const lines = [0, 1, 2].map(i => el('div', 'abs', card, { left: '44px', top: 150 + i * 72 + 'px', height: '26px', borderRadius: '13px', background: '#e7e2d7', width: '0px' }));
  const chips = S.chips.slice(0, 3).map((c, i) => { const n = el('div', 'abs', root, { left: '1250px', top: 470 + i * 100 + 'px', display: 'flex', alignItems: 'center', gap: '12px', height: '72px', padding: '0 26px', borderRadius: '999px', background: i === 2 ? HL : '#fff', boxShadow: `0 16px 30px -14px rgba(40,30,10,.45), 0 0 0 2px ${INK}`, font: '600 32px var(--ui)', whiteSpace: 'nowrap' }); n.innerHTML = icon(c.icon || 'check', 32, INK, 2.2) + `<span>${esc(c.text)}</span>`; return n; });
  const c1 = S.headline[0];
  const h1 = line(root, runs(c1, S.highlight[0]), { top: '170px' });
  // small chip that keeps line 1 on screen during part B
  const mini = el('div', 'abs', root, { left: '60px', top: '50px', padding: '14px 24px', borderRadius: '18px', background: 'var(--bg)', boxShadow: '0 10px 30px -14px rgba(40,30,10,.4), 0 0 0 1px rgba(20,20,20,.06)', font: ZH ? "400 44px 'Smiley Sans'" : '700 42px var(--display)', letterSpacing: ZH ? '.01em' : '-.02em', zIndex: 5, whiteSpace: 'nowrap' });
  mixed(mini, c1);
  const frags = [...Array(18)].map((_, i) => el('div', 'abs', root, { width: '110px', height: '70px', borderRadius: '10px', background: '#fff', boxShadow: `0 0 0 2px ${INK}`, display: 'none', left: 580 + (i % 6) * 127 + 'px', top: 400 + Math.floor(i / 6) * 140 + 'px' }));
  // part B: the wall of the product's real screens, grouped into four categories
  const wall = el('div', 'abs', root, { width: '1920px', height: '1080px', transformOrigin: '50% 50%' });
  const items = S.wall.map(x => ({ ...x, cat: clamp(x.cat | 0, 0, 3) }));
  const byCat = [0, 1, 2, 3].map(k => items.filter(x => x.cat === k)), order = [];
  let ci = 0, guard = 0; while (order.length < items.length && guard++ < 999) { const q = byCat[ci % 4]; if (q.length) order.push(q.shift()); ci++; }
  const colW = 300, gp = 24, x0 = (1920 - (7 * colW + 6 * gp)) / 2, th = 188;
  const cols = [...Array(7)].map((_, c) => { const col = el('div', 'abs', wall, { left: x0 + c * (colW + gp) + 'px', top: '-60px', width: colW + 'px' });
    const tiles = [...Array(6)].map((_, j) => { const s = order[(c * 6 + j + c * 2) % order.length]; const t = el('div', 'card', col, { position: 'relative', width: colW + 'px', height: th + 'px', marginBottom: gp + 'px' }); img(t, s.src, { position: 'static' }, '');
      let badge = null; if (s.video) { badge = el('div', 'abs', t, { left: '12px', top: 'auto', bottom: '12px', display: 'none', alignItems: 'center', justifyContent: 'center', width: '40px', height: '40px', borderRadius: '999px', background: HL }); badge.innerHTML = icon('play', 16, INK, 0); }
      return { t, s, badge }; });
    return { col, tiles, c }; });
  const catChip = el('div', 'abs', root, { left: '90px', top: '480px', height: '96px', padding: '0 40px', borderRadius: '999px', background: HL, display: 'flex', alignItems: 'center', font: '700 52px var(--ui)', boxShadow: `0 20px 40px -16px rgba(0,0,0,.45), 0 0 0 3px ${INK}`, zIndex: 6, whiteSpace: 'nowrap' });
  const plate = el('div', 'abs', root, { left: '360px', top: '330px', width: '1200px', height: '420px', borderRadius: '40px', background: 'var(--bg)', boxShadow: '0 40px 90px -30px rgba(40,30,10,.55)', zIndex: 7 });
  const h2 = line(plate, runs(S.headline[1], S.highlight[1]), { top: '90px' });
  h2.spans.forEach(s => { if (s.hl) { s.style.backgroundImage = `linear-gradient(${HL}, ${HL})`; s.style.backgroundPosition = '0 96%'; } });
  const sub = el('div', 'fs', plate, { top: '270px', left: '0', width: '1200px', textAlign: 'center' }); sub.textContent = S.sub || '';
  let meas = false;
  return b => {
    if (!meas) { h1.fit(1700, 124, '(what line 1)'); h1.style.left = (1920 - h1.scrollWidth) / 2 + 'px'; h2.fit(1080, 124, '(what line 2)'); h2.style.left = (1200 - h2.scrollWidth) / 2 + 'px'; fitText(sub, 1100, 44);
      chips.forEach(c => { if (c.offsetWidth > 620) { warn(`chip "${c.textContent}" is wide; keep chips to 1-3 words`); c.style.transform = ''; } }); fitText(mini, 900, ZH ? 44 : 42); meas = true; }
    // card lands with a squash, writes its lines, grows chips, shivers and bursts
    const ck = clamp((b - 16) / .25), sq = b >= 16.25 ? 1 - spring(sec(b - 16.25), .18, 9, 22) : 1;
    const shiver = b >= 19 && b < 19.5 ? Math.sin(b * 90) * 6 : 0;
    const burst = eOut((b - 19.5) / .5);
    card.style.display = b < 20 ? 'block' : 'none';
    card.style.transform = `translate(${shiver}px, ${(1 - eOut(ck)) * 700}px) scale(${(2 - sq) * (1 + burst * .15)}, ${sq * (1 + burst * .15)})`; card.style.opacity = 1 - burst;
    lines.forEach((ln, i) => { ln.style.width = eOut((b - 16.5 - i * .33) / .4) * [620, 540, 430][i] + 'px'; });
    chips.forEach((c, i) => { const at = 17.5 + i * .5; const k = eBack((b - at) / .35); c.style.display = b >= at && b < 20 ? 'flex' : 'none'; const over = Math.max(0, c.offsetWidth - 620); c.style.transform = `translateX(${(1 - k) * 60 - over}px) scale(${lerp(.6, 1, k)})`; c.style.opacity = 1 - burst; });
    frags.forEach((f, i) => { const k = clamp((b - 19.5) / .5); f.style.display = b >= 19.5 && b < 20 ? 'block' : 'none'; const a = (i / 18) * Math.PI * 2; f.style.transform = `translate(${Math.cos(a) * 600 * eOut(k)}px, ${Math.sin(a) * 400 * eOut(k)}px) rotate(${i * 20 * k}deg)`; f.style.opacity = 1 - k; });
    // line 1: above the card, then shrinks into the corner chip
    const toMini = eInOut((b - 19) / .4);
    h1.style.display = b < 19.4 ? 'block' : 'none'; rise(h1, b, 17, 50, .4); h1.hl(eOut((b - 18) / .35));
    if (b >= 19) { h1.style.transform = `translate(${-toMini * 700}px, ${-toMini * 110}px) scale(${lerp(1, .35, toMini)})`; h1.style.opacity = 1 - clamp((b - 19.3) / .1); }
    mini.style.display = b >= 19.3 ? 'block' : 'none'; mini.style.opacity = clamp((b - 19.3) / .2);
    // wall: columns fall/rise in, drift in opposite directions, categories light up on the beats
    wall.style.display = b >= 20 ? 'block' : 'none';
    const lit = b < 21 ? null : b < 25 ? Math.floor(b - 21) : 'all';
    cols.forEach(({ col, tiles, c }) => {
      const at = 20 + c * .125, k = eOut((b - at) / .35), dir = c % 2 ? 1 : -1;
      const drift = (b - 20) * 26 * (c % 2 ? -1 : 1);
      col.style.transform = `translateY(${(1 - k) * dir * 1100 + drift}px)`; col.style.opacity = b >= at ? 1 : 0;
      tiles.forEach(o => { const on = lit === 'all' || lit === o.s.cat; o.t.style.filter = lit === null || !on ? 'saturate(.6)' : 'none'; o.t.style.opacity = lit !== null && on ? 1 : .35;
        if (o.badge) o.badge.style.display = b >= 21 && on ? 'flex' : 'none'; });
    });
    const zoom = eInOut((b - 25) / 2); const out = eIn((b - 27.5) / .4);
    wall.style.transform = `translateX(${-out * 2200}px) scale(${lerp(1, .8, zoom)})`;
    catChip.style.display = b >= 21 && b < 25 ? 'flex' : 'none';
    if (b >= 21 && b < 25) { const i = Math.floor(b - 21); catChip.textContent = S.categories[i] || ''; const k = eBack((b - 21 - i) / .3); catChip.style.transform = `rotateX(${(1 - k) * 80}deg) scale(${lerp(.8, 1, k)})`; }
    plate.style.display = b >= 25 ? 'block' : 'none';
    if (b >= 25) { slam(plate, b, 25); h2.hl(eOut((b - 25.5) / .35)); sub.style.opacity = clamp((b - 25.2) / .4); }
  };
}

// ---------- Scene 3: fit (where it works / who it is for) ----------
function scene3(root, S, crew) {
  const T = tile(root, 70, { left: '925px', top: '60px' }); T.draw(1);
  const [a, z] = S.headline;
  const h = line(root, [{ t: a }, { t: gap(a, z) + z }], { top: '150px', left: '240px' });
  const X = [240, 610, 980, 1350], Y = 370, TW = 330, TH = 250;
  const tiles = S.items.slice(0, 3).map((it, i) => { const t = el('div', 'abs', root, { left: X[i] + 'px', top: Y + 'px', width: TW + 'px', height: TH + 'px', borderRadius: '30px', background: '#fff', boxShadow: '0 26px 50px -28px rgba(40,30,10,.4), 0 0 0 1px rgba(20,20,20,.07)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '20px' });
    if (it.logo) img(t, it.logo, { position: 'static', width: '104px', height: '104px', objectFit: 'contain' }, '');
    else { const ic = el('div', '', t, { width: '104px', height: '104px', borderRadius: '28px', background: i === 1 ? HL : '#f1eee7', display: 'flex', alignItems: 'center', justifyContent: 'center' }); ic.innerHTML = icon(it.icon || 'sparkles', 60, INK, 2); }
    const nm = el('div', '', t, { font: '600 32px var(--ui)', textAlign: 'center', padding: '0 18px', lineHeight: 1.15 }); nm.textContent = it.name;
    const chip = el('div', 'abs', root, { left: X[i] + TW / 2 + 'px', top: Y + TH + 26 + 'px', display: 'flex', alignItems: 'center', gap: '8px', height: '52px', padding: '0 20px', borderRadius: '999px', background: HL, font: '600 26px var(--ui)', whiteSpace: 'nowrap' }); chip.innerHTML = icon('check', 24, INK, 3) + esc(it.chip || S.chip);
    return { t, nm, chip, i }; });
  const more = el('div', 'abs', root, { left: X[3] + 'px', top: Y + 'px', width: TW + 'px', height: TH + 'px', borderRadius: '30px', border: '4px dashed #bfb7a8', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 30px', font: '600 30px/1.3 var(--ui)', color: '#6d6a63', background: 'rgba(255,255,255,.4)' });
  const moreLbl = el('div', '', more); moreLbl.textContent = S.more;
  const fine = el('div', 'abs', root, { left: '120px', width: '1680px', top: '972px', textAlign: 'center', font: '500 32px/1.3 var(--ui)', color: 'rgba(18,19,19,.7)', textWrap: 'balance' }); fine.textContent = S.finePrint || '';
  const blip = img(root, crew.c4.file, { width: '230px', height: '230px', left: X[3] + TW / 2 - 115 + 'px', top: Y + TH / 2 - 125 + 'px', transformOrigin: '50% 90%', display: 'none' });
  let meas = false;
  return b => {
    if (!meas) { h.fit(1500, 112, '(fit)'); tiles.forEach(({ nm }) => fitText(nm, TW - 36, 32)); meas = true; }
    tiles.forEach(({ t, chip, i }) => { const at = 28 + i * .5; const k = eOut((b - at) / .4); const bob = b >= 33 && b < 33.5 ? Math.sin((b - 33 + i * .25) * Math.PI * 4) * 8 : 0; const fade = 1 - clamp((b - 32.9) / .45);
      t.style.opacity = (b >= at ? 1 : 0) * fade; t.style.transform = `translateX(${(1 - k) * 900}px) translateY(${bob}px)`;
      const ca = 31.5 + i * .5; const ck = eBack((b - ca) / .3); chip.style.display = b >= ca ? 'flex' : 'none'; chip.style.opacity = fade; chip.style.transform = `translateX(-50%) scale(${lerp(.4, 1, ck)})`; });
    more.style.opacity = clamp((b - 29.5) / .3) * (1 - clamp((b - 35.5) / .3));
    fine.style.opacity = clamp((b - 28) / .3) * (1 - clamp((b - 35.5) / .3));
    rise(h.spans[0], b, 30, 50, .4); rise(h.spans[1], b, 31, 50, .4);
    // the animator lands in the empty slot, bobs hopefully, and gets popped out by the label
    const inSlot = b >= 34 && b < 35.3; blip.style.display = inSlot ? 'block' : 'none';
    if (inSlot) { const sq = 1 - spring(sec(b - 34), .28, 8, 22); const bob = b >= 34.5 && b < 35 ? Math.sin((b - 34.5) * Math.PI * 4) * 10 : 0;
      const pp = b >= 35 ? eIn((b - 35) / .3) : 0; blip.style.transform = `translateY(${bob + pp * 400}px) scale(${2 - sq}, ${sq})`; }
    const lblIn = 35.2;   // after the pop-out has cleared the slot
    moreLbl.style.transform = b < 33.6 ? 'translateY(0)' : b < lblIn ? 'translateY(-160px)' : `translateY(${(1 - eBack((b - lblIn) / .3)) * -160}px)`;
    moreLbl.style.opacity = b < 33.6 ? 1 : b < lblIn ? 0 : clamp((b - lblIn) / .12);
    // match cut: the tile stretches into the next scene's pill button
    const st = eInOut((b - 35.5) / .5); T.style.width = lerp(70, 820, st) + 'px'; T.style.left = 960 - lerp(70, 820, st) / 2 + 'px'; T.style.borderRadius = lerp(15, 42, st) + 'px'; T.style.height = lerp(70, 84, st) + 'px'; T.style.background = st > .5 ? INK : ''; T.mark.style.opacity = 1 - st;
    h.style.opacity = 1 - clamp((b - 35.6) / .3);
  };
}

// ---------- Scene 4: how it works ----------
function scene4(root, S) {
  const scale = el('div', 'abs', root, { width: '1920px', height: '1080px', transformOrigin: '960px 540px' });
  const btn = el('div', 'abs', scale, { left: '550px', top: '60px', width: '820px', height: '84px', borderRadius: '42px', background: INK, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', font: '600 34px var(--ui)', overflow: 'hidden', whiteSpace: 'nowrap' });
  const words3 = S.steps.slice(0, 3).map((w, i) => line(scale, [{ t: w }], { left: '110px', top: 300 + i * 170 + 'px' }));
  const card = el('div', 'abs', scale, { left: '860px', top: '230px', width: '960px', height: '720px', borderRadius: '34px', background: '#fff', boxShadow: '0 40px 80px -40px rgba(40,30,10,.45), 0 0 0 1px rgba(20,20,20,.06)', overflow: 'hidden' });
  const ch = el('div', 'abs', card, { left: '0', right: '0', top: '0', height: '78px', borderBottom: '1px solid #ece8df', display: 'flex', alignItems: 'center', gap: '14px', padding: '0 30px', font: '600 30px var(--ui)' });
  ch.innerHTML = '<span style="display:flex;gap:9px"><i style="width:14px;height:14px;border-radius:50%;background:#ff5f57;display:block"></i><i style="width:14px;height:14px;border-radius:50%;background:#febc2e;display:block"></i><i style="width:14px;height:14px;border-radius:50%;background:#28c840;display:block"></i></span>' + `<span style="margin-left:10px">${esc(S.cardTitle)}</span>`;
  const okBadge = el('div', 'abs', ch, { left: 'auto', right: '26px', top: '17px', width: '44px', height: '44px', borderRadius: '50%', background: HL, display: 'none', alignItems: 'center', justifyContent: 'center' }); okBadge.innerHTML = icon('check', 26, INK, 3.2);
  const sentence = S.input, mark = S.inputHighlight && sentence.includes(S.inputHighlight) ? S.inputHighlight : null;
  const hlHtml = (color) => mark ? esc(sentence).replace(esc(mark), `<u style="text-decoration:none;${color}">${esc(mark)}</u>`) : esc(sentence);
  const inputHtml = hlHtml(`background:linear-gradient(${HL},${HL}) no-repeat 0 90%/100% 38%`), sentHtml = hlHtml(`color:${HL}`);
  const input = el('div', 'abs mono', card, { left: '30px', right: '30px', top: '560px', minHeight: '110px', borderRadius: '22px', background: 'var(--bg)', padding: '20px 90px 20px 24px', boxSizing: 'border-box', font: '500 30px/1.4 var(--mono)', color: '#2a2b2b' });
  const inputTxt = el('div', '', input); const send = el('div', 'abs', input, { left: 'auto', right: '18px', top: 'auto', bottom: '18px', width: '60px', height: '60px', borderRadius: '50%', background: INK, display: 'flex', alignItems: 'center', justifyContent: 'center' }); send.innerHTML = icon('arrow-up', 32, '#fff', 2.6);
  const sent = el('div', 'abs mono', card, { left: 'auto', right: '30px', top: '100px', width: '780px', borderRadius: '24px 24px 6px 24px', background: INK, color: '#fff', padding: '20px 24px', boxSizing: 'border-box', font: '500 28px/1.4 var(--mono)' }); sent.innerHTML = sentHtml;
  const strip = el('div', 'abs mono', scale, { left: '560px', top: '160px', padding: '14px 22px', borderRadius: '14px', background: '#fff', boxShadow: '0 20px 40px -16px rgba(0,0,0,.4)', font: '500 26px var(--mono)', whiteSpace: 'nowrap', opacity: .9 }); strip.textContent = sentence.length > 44 ? sentence.slice(0, 44) + '…' : sentence;
  const reply = el('div', 'abs', card, { left: '30px', top: '300px', width: '900px' });
  const thumbs = [0, 1, 2].map(i => { const c = el('div', 'card', reply, { left: i * 300 + 'px', top: '0', width: '280px', height: '160px', borderRadius: '14px' }); img(c, pick(S.results, i), { position: 'static' }, '');
    const ck = el('div', 'abs', c, { left: 'auto', right: '10px', top: '10px', width: '46px', height: '46px', borderRadius: '50%', background: HL, display: 'none', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 14px -6px rgba(0,0,0,.4)' }); ck.innerHTML = icon('check', 28, INK, 3.4); return { c, ck }; });
  const cli = el('div', 'abs mono', reply, { left: '0', top: '184px', width: '880px', font: '500 27px/1.5 var(--mono)', color: '#2a2b2b', whiteSpace: 'normal' });
  // covers the whole sent bubble; pops from and collapses into the header check badge
  const D = S.dialog;
  const win = el('div', 'abs', scale, { left: '1000px', top: '320px', width: '810px', height: '410px', borderRadius: '26px', background: '#fff', boxShadow: '0 50px 90px -30px rgba(0,0,0,.5), 0 0 0 1px rgba(20,20,20,.08)', overflow: 'hidden', transformOrigin: '772px -51px' });
  const wbar = el('div', 'abs', win, { left: '0', right: '0', top: '0', height: '46px', background: '#f4f1ea', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 18px' }); wbar.innerHTML = '<i style="width:12px;height:12px;border-radius:50%;background:#ff5f57;display:block"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e;display:block"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840;display:block"></i>';
  const wt = tile(win, 64, { left: '40px', top: '76px' }); wt.draw(1);
  const wtitle = el('div', 'abs', win, { left: '124px', top: '84px', font: '700 38px var(--ui)', whiteSpace: 'nowrap' }); wtitle.textContent = D.title;
  el('div', 'abs', win, { left: '40px', top: '176px', font: '500 24px var(--ui)', color: '#6d6a63' }).textContent = D.label;
  const wval = el('div', 'abs mono', win, { left: '40px', top: '212px', font: '700 44px var(--mono)', letterSpacing: '.04em', whiteSpace: 'nowrap' }); wval.textContent = D.value;
  el('div', 'abs', win, { left: '40px', top: '310px', width: '350px', height: '66px', borderRadius: '16px', background: '#f1eee7', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 28px var(--ui)', color: '#6d6a63' }).textContent = D.deny;
  const approve = el('div', 'abs', win, { left: '410px', top: '310px', width: '360px', height: '66px', borderRadius: '16px', background: INK, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 28px var(--ui)' }); approve.textContent = D.approve;
  const bigCheck = el('div', 'abs', scale, { left: '560px', top: '620px', width: '150px', height: '150px', borderRadius: '50%', background: HL, display: 'none', alignItems: 'center', justifyContent: 'center', boxShadow: '0 20px 40px -14px rgba(0,0,0,.4)' }); bigCheck.innerHTML = icon('check', 96, INK, 3.4);
  const smalls = [...Array(6)].map(() => { const d = el('div', 'abs', root, { width: '56px', height: '56px', borderRadius: '50%', background: HL, display: 'none', alignItems: 'center', justifyContent: 'center' }); d.innerHTML = icon('check', 32, INK, 3.4); return d; });
  const sub = el('div', 'fs', root, { top: '978px', left: '0', width: '1920px', textAlign: 'center', fontSize: '44px' }); sub.textContent = S.sub || '';
  const ptr = el('div', 'abs', root, { width: '64px', height: '64px' }); ptr.innerHTML = INK_PTR;
  const vals = S.resultValues;
  const lineHtml = v => { const chip = `<b style="background:${HL};padding:0 6px;border-radius:6px;font-weight:600;white-space:nowrap">${esc(v)}</b>`; const tpl = esc(S.resultLine || '{x}'); return (S.resultPrefix ? `<span style="color:#8a867d">${esc(S.resultPrefix)}</span> ` : '') + (tpl.includes('{x}') ? tpl.replace('{x}', chip) : tpl + ' ' + chip); };
  let meas = false;
  return b => {
    if (!meas) { words3.forEach((w, i) => w.fit(560, 150, `(step ${i + 1})`)); fitText(wtitle, 640, 38); fitText(wval, 730, 44); fitText(sub, 1800, 44); meas = true; }
    // button: stretched in from the tile, clicked, flips to its done label
    const done = b >= 36.5, flash = done && b < 37;
    btn.style.background = flash ? HL : INK; btn.style.color = flash ? INK : '#fff';
    btn.innerHTML = icon(done ? 'check' : (S.buttonIcon || 'mouse-pointer-click'), 34, flash ? INK : '#fff', 2.4) + `<span>${esc(done ? S.buttonDone : S.button)}</span>`;
    btn.style.transform = `scale(${b >= 36.5 && b < 36.65 ? .95 : 1})`;
    words3.forEach((w, i) => { const at = [36, 38, 45][i]; slam(w, b, at); });
    words3[0].style.opacity = b >= 36 ? (b >= 38 ? .3 : 1) : 0; if (words3[1]) words3[1].style.opacity = b >= 38 ? (b >= 45 ? .3 : 1) : 0;
    // the ghost strip flies from the button into the card
    const sk = clamp((b - 37) / 1); strip.style.display = b >= 37 && b < 38 ? 'block' : 'none'; strip.style.transform = `translate(${eInOut(sk) * 500}px, ${eIn(sk) * 480}px) rotate(${sk * 6}deg)`;
    // paste, send, lift into a sent bubble
    const pasted = b >= 38 && b < 38.5; inputTxt.innerHTML = pasted ? inputHtml : ''; input.style.boxShadow = pasted ? `0 0 0 3px ${HL}` : 'none';
    send.style.transform = `scale(${b >= 38.5 && b < 38.65 ? .88 : 1})`;
    const sk2 = eOut((b - 38.5) / .5); sent.style.display = b >= 38.5 ? 'block' : 'none'; sent.style.transform = `translateY(${(1 - sk2) * 440}px)`; sent.style.opacity = clamp((b - 38.5) / .2);
    // the dialog pops, its confirm button is clicked, the window collapses into the header check
    const wk = eBack((b - 39.5) / .4), wc = eIn((b - 41) / .35);
    win.style.display = b >= 39.5 && b < 41.35 ? 'block' : 'none'; win.style.transform = `scale(${lerp(.6, 1, wk) * (1 - wc * .96)})`; win.style.opacity = 1 - clamp((wc - .6) / .4);
    approve.style.transform = `scale(${b >= 40.5 && b < 40.65 ? .94 : 1})`;
    okBadge.style.display = b >= 41.3 ? 'flex' : 'none'; okBadge.style.transform = `scale(${lerp(.3, 1, eBack((b - 41.3) / .3))})`;
    sub.style.opacity = clamp((b - 41) / .4) * (1 - clamp((b - 47.5) / .3));
    // results, the result line with flipping values, a check per result
    reply.style.display = b >= 41.5 ? 'block' : 'none';
    thumbs.forEach(({ c, ck }, i) => { const k = eBack((b - 41.5 - i * .1) / .4); c.style.transform = `translateY(${(1 - k) * 60}px)`; c.style.opacity = clamp((b - 41.5 - i * .1) / .15);
      const at = 42.5 + i; ck.style.display = b >= at ? 'flex' : 'none'; ck.style.transform = `scale(${lerp(.3, 1, eBack((b - at) / .3))})`; });
    const si = b < 43 ? 0 : b < 44 ? 1 : 2; cli.style.display = b >= 42 ? 'block' : 'none';
    cli.innerHTML = lineHtml(pick(vals, si));
    // done: big check, then it splits into six checks that fly out of the top
    const last = words3[words3.length - 1];
    const bk = eBack((b - 45) / .35), sq = b >= 45 ? 1 - spring(sec(b - 45), .2, 9, 22) : 1;
    bigCheck.style.display = b >= 45 && b < 47.5 ? 'flex' : 'none'; bigCheck.style.transform = `scale(${lerp(.3, 1, bk) * (2 - sq)}, ${lerp(.3, 1, bk) * sq})`;
    bigCheck.style.left = Math.min(110 + last.scrollWidth + 34, 690) + 'px'; bigCheck.style.top = 640 + (last.offsetHeight - 150) / 2 + 'px';
    smalls.forEach((d, i) => { const k = clamp((b - 47.5) / .5); d.style.display = b >= 47.5 && b < 48 ? 'flex' : 'none'; const cx = parseFloat(bigCheck.style.left) + 75, cy = parseFloat(bigCheck.style.top) + 75; d.style.transform = `translate(${cx - 28 + (i - 2.5) * 140 * eOut(k)}px, ${cy - 28 - eIn(k) * 900}px)`; });
    scale.style.transform = `scale(${1 + .03 * eInOut((b - 45) / 2.5)})`;
    // the in-film pointer: clicks the button (b36.5) and the confirm (b40.5)
    const P = [[35.8, 1500, 900], [36.4, 980, 110], [36.8, 1060, 170], [39.8, 1300, 760], [40.4, 1480, 660], [40.9, 1600, 820], [42, 1750, 1100]];
    let px = P[0][1], py = P[0][2]; for (let i = 0; i < P.length - 1; i++) if (b >= P[i][0] && b < P[i + 1][0]) { const k = eInOut((b - P[i][0]) / (P[i + 1][0] - P[i][0])); px = lerp(P[i][1], P[i + 1][1], k); py = lerp(P[i][2], P[i + 1][2], k); } if (b >= P[P.length - 1][0]) { px = P[P.length - 1][1]; py = P[P.length - 1][2]; }
    const press = (b >= 36.45 && b < 36.6) || (b >= 40.45 && b < 40.6) ? .85 : 1;
    ptr.style.transform = `translate(${px}px, ${py}px) scale(${press})`; ptr.style.display = b < 42 ? 'block' : 'none';
  };
}

// ---------- Scene 5: proof ----------
function scene5(root, S) {
  const CW = 360, CHh = 225, X0 = 744, Y0 = 228, GX = 26, GY = 58;
  const cards = [0, 1, 2, 3, 4, 5].map(i => { const r = Math.floor(i / 3), c = i % 3; const x = X0 + c * (CW + GX), y = Y0 + r * (CHh + GY);
    const d = el('div', 'card', root, { left: x + 'px', top: y + 'px', width: CW + 'px', height: CHh + 'px', borderRadius: '18px' }); img(d, pick(S.cards, i), { position: 'static' }, '');
    return { d, x, y, i }; });
  cards.forEach(c => { const st = el('div', 'stamp', root, { left: c.x + CW - 162 + 'px', top: c.y + 12 + 'px', width: '150px', height: '150px', display: 'none', gap: '2px', fontSize: '25px', zIndex: 4, padding: '0 14px', boxSizing: 'border-box' }); st.innerHTML = icon(S.stampIcon || 'badge-check', 54, INK, 2.4) + `<span>${esc(S.stamp)}</span>`; c.st = st; });
  const h1 = line(root, [{ t: S.headline[0] }], { left: '110px', top: '320px' }), h2 = line(root, [{ t: S.headline[1] }], { left: '110px', top: '460px' });
  const sub = el('div', 'fs', root, { left: '114px', top: '630px', fontSize: '44px', whiteSpace: 'normal', width: '600px', textWrap: 'balance' }); sub.textContent = S.sub || '';
  const T = tile(root, 300, { left: '810px', top: '390px' });
  const ptr = el('div', 'abs', root, { width: '64px', height: '64px', zIndex: 5 }); ptr.innerHTML = INK_PTR;
  let meas = false;
  return b => {
    if (!meas) { h1.fit(600, 120, '(proof line 1)'); h2.fit(600, 120, '(proof line 2)'); if (sub.offsetHeight > 180) warn(`proof sub "${S.sub}" runs past three lines; shorten it`); meas = true; }
    const stack = eInOut((b - 54.5) / .6);
    cards.forEach(({ d, st, x, y, i }) => {
      const at = 48 + i * .25; const k = eBack((b - at) / .4);
      const dx = (960 - CW / 2 - x) * stack, dy = (540 - CHh / 2 - y) * stack;
      d.style.opacity = clamp((b - at) / .1) * (1 - clamp((b - 55.4) / .2)); d.style.transform = `translate(${dx + i * 3 * stack}px, ${dy - i * 3 * stack}px) scale(${lerp(.2, 1, k) * lerp(1, .9, stack)}) rotate(${(i - 2.5) * 2 * stack}deg)`;
      const sa = 50.5 + i * .5; const sk = eBack((b - sa) / .3); const sq = b >= sa ? 1 - spring(sec(b - sa), .2, 9, 22) : 1;
      st.style.display = b >= sa && b < 54.5 ? 'flex' : 'none'; st.style.transform = `scale(${lerp(1.8, 1, sk) * (2 - sq)}, ${lerp(1.8, 1, sk) * sq}) rotate(-12deg)`;
    });
    rise(h1, b, 50, 50, .4); rise(h2, b, 52, 50, .4); sub.style.opacity = clamp((b - 52.2) / .4);
    const out = clamp((b - 55) / .3); [h1, h2, sub].forEach(e => { if (b >= 55) e.style.opacity = 1 - out; });
    // the stack becomes the product tile; the mark draws again
    const tk = eBack((b - 55.5) / .4); T.style.display = b >= 55.4 ? 'block' : 'none'; T.style.transform = `scale(${lerp(.6, 1, tk)})`; T.draw(eOut((b - 55.6) / .4));
    // the in-film pointer stamps each card
    let px = 1900, py = 1100;
    if (b >= 50.1 && b < 53.6) { const i = clamp(Math.floor((b - 50.25) * 2), 0, 5), c = cards[i]; const tx0 = c.x + CW - 40, ty0 = c.y + 150;
      const prev = i ? cards[i - 1] : { x: 1500, y: 700 }; const k = eInOut(((b - 50.25) * 2 - i) / .5 + .5); px = lerp(prev.x + CW - 40, tx0, clamp(k)); py = lerp(prev.y + 150, ty0, clamp(k)); }
    else if (b >= 53.6) { const k = eIn((b - 53.6) / .6); px = cards[5].x + CW - 40 + k * 400; py = cards[5].y + 150 + k * 500; }
    ptr.style.display = b >= 50 && b < 54.3 ? 'block' : 'none'; ptr.style.transform = `translate(${px}px, ${py}px) scale(${b % .5 < .08 && b >= 50.5 ? .85 : 1})`;
  };
}

// ---------- End card (native 1920x1080) ----------
function endCard(root, E, crew) {
  el('div', 'fill', root, { background: 'radial-gradient(80% 90% at 50% 30%, #fffdf6, var(--bg) 70%)' });
  const T = tile(root, 300, { left: '0', top: '0' });
  const wm = wordmark(root, 150, {});
  const [a, z] = E.headline;
  const hlIn1 = E.highlight && a.includes(E.highlight) && !z.includes(E.highlight);
  const parts = [...runs(a + gap(a, z), hlIn1 ? E.highlight : null), ...runs(z, hlIn1 ? null : E.highlight).map(r => ({ ...r, c2: true }))];
  const h = line(root, parts, { top: '385px' });
  h.spans.forEach((s, i) => { s.c2 = !!parts[i].c2; });
  const pill = el('div', 'abs', root, { top: '556px', height: '84px', padding: '0 40px', borderRadius: '999px', background: INK, color: '#fff', display: 'flex', alignItems: 'center', gap: '14px', font: '600 40px var(--ui)', whiteSpace: 'nowrap' }); pill.innerHTML = icon('globe', 34, HL, 2.2) + esc(E.url);
  const sub = el('div', 'fs', root, { top: '664px', left: '0', width: '1920px', textAlign: 'center', fontSize: '40px' }); sub.textContent = E.sub || '';
  const shadows = [0, 1, 2, 3, 4].map(i => el('div', 'abs', root, { width: '120px', height: '22px', left: 960 + (i - 2) * 210 - 60 + 'px', top: '1036px', borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(110,92,60,.4), rgba(110,92,60,0))' }));
  const crewImgs = ['c5', 'c4', 'c1', 'c3', 'c2'].map((id, i) => img(root, crew[id].file, { width: '170px', height: '170px', left: 960 + (i - 2) * 210 - 85 + 'px', top: '876px', transformOrigin: '50% 95%' }));
  let meas = null;
  return b => {
    if (!meas) {
      h.fit(1700, 132, '(end card)'); const hw = h.scrollWidth; h.style.left = (1920 - hw) / 2 + 'px'; const pw = pill.offsetWidth; pill.style.left = (1920 - pw) / 2 + 'px'; fitText(sub, 1700, 40);
      let w = wm.measure(); if (170 + 44 + w > 1700) { const k = (1700 - 214) / w; if (wm.style.fontSize) wm.style.fontSize = 150 * k + 'px'; else wm.style.height = 150 * k + 'px'; w = wm.measure(); }
      meas = { wm: w, h: parseFloat(wm.style.fontSize || wm.style.height || 150) };
    }
    const g = 170 + 44 + meas.wm, tx1 = 960 - g / 2 + 85;
    // tile lifts to upper centre, the mark redraws, the wordmark wipes in
    const lift = eInOut((b - 68) / .6), slide = eInOut((b - 68.6) / .4);
    const size = lerp(300, 170, lift), cx = lerp(960, tx1, slide), cy = lerp(540, 236, lift);
    const punch = b >= 74 ? 1 + .08 * Math.sin(Math.PI * clamp((b - 74) / .5)) : 1, dip = b >= 73 && b < 74 ? 1 - .03 * Math.sin(Math.PI * clamp(b - 73)) : 1;
    T.style.transform = `translate(${cx - 150}px, ${cy - 150}px) scale(${size / 300 * punch * dip})`;
    T.draw(b < 68.5 ? 1 : eOut((b - 68.5) / .5));
    wm.style.left = tx1 + 85 + 44 + 'px'; wm.style.top = 236 - meas.h * .52 + 'px'; wm.style.clipPath = `inset(-20% ${100 - eOut((b - 69) / .5) * 100}% -20% 0)`; wm.style.opacity = b >= 69 ? 1 : 0;
    // headline: line 1 at b70, line 2 at b71, highlighter at b71.5 (flash on the final hit)
    h.spans.forEach(s => { const at = s.c2 ? 71 : 70; const k = eOut((b - at) / .4); s.style.opacity = k; s.style.transform = `translateY(${(1 - k) * 50}px)`; });
    const flash = b >= 74 && b < 74.3 ? 1.08 : 1; h.hl(eOut((b - 71.5) / .35) * flash);
    const pk = eOut((b - 72) / .4); pill.style.opacity = pk; pill.style.transform = `translateY(${(1 - pk) * 60}px)`;
    sub.style.opacity = clamp((b - 72.5) / .4);
    // the crew peek up, squash on the pre-hit dip, jump on the final hit and freeze at the top
    crewImgs.forEach((c, i) => {
      const up = eBack((b - 72.5 - i * .06) / .5); let y = lerp(220, 0, up), sx = 1, sy = 1;
      if (b >= 73 && b < 74) { const k = Math.sin(Math.PI / 2 * clamp((b - 73) / .5)); sy = 1 - .15 * k; sx = 1 + .1 * k; y += 10 * k; }
      if (b >= 74) { const k = eOut(clamp((b - 74) / .25)); y -= 96 * k; sy = lerp(.85, 1.12, k); sx = lerp(1.1, .92, k); }
      c.style.transform = `translateY(${y}px) scale(${sx}, ${sy})`;
      const air = b >= 74 ? eOut(clamp((b - 74) / .25)) : 0; shadows[i].style.opacity = clamp(up) * lerp(1, .32, air); shadows[i].style.transform = `scale(${lerp(1, .5, air)})`;
    });
  };
}

window.__buildFilm = ({ SB: sb, CREW, host, endHost }) => {
  SB = sb; BEAT = window.__fx.BEAT; ZH = !!sb.cjk; HL = window.__fx.HL; INK = window.__fx.INK;
  const S = SB.scenes;
  const mk = (fn, data, from, to) => { const root = el('div', 'fill', host, { display: 'none' }); return { root, from, to, fn, data, upd: null }; };
  const list = [mk(scene1, S.brand, 8, 16), mk(scene2, S.what, 16, 28), mk(scene3, S.fit, 28, 36), mk(scene4, S.how, 36, 48), mk(scene5, S.proof, 48, 999)];
  const endRoot = el('div', 'fill', endHost);
  let endUpd = null;
  window.__updateFilm = (b, fb) => {
    list.forEach(s => {
      const on = fb >= s.from && fb < s.to && b >= 8;
      s.root.style.display = on ? 'block' : 'none';
      if (on) { if (!s.upd) s.upd = s.fn(s.root, s.data, CREW); s.upd(fb); }
    });
    if (b >= 68) { if (!endUpd) endUpd = endCard(endRoot, SB.end, CREW); endUpd(b); }
  };
};
})();
