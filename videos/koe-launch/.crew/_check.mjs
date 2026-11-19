import { serveDir } from '/c/Users/User/.agents/skills/bs-plush-crew-launch-video/scripts/lib/server.mjs';
import { launchChromium } from '/c/Users/User/.agents/skills/bs-plush-crew-launch-video/scripts/lib/browser.mjs';

const s = await serveDir('film');
const b = await launchChromium({ headless: true, args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage();
const logs = [];
pg.on('console', m => logs.push(m.type() + ':' + m.text()));
pg.on('pageerror', e => logs.push('pageerror:' + e.message));
await pg.goto(s.url + 'index.html?render=1', { waitUntil: 'networkidle', timeout: 90000 });
const r = await pg.evaluate(() => ({ has: !!window.__film, ready: window.__film?.ready, dur: window.__film?.duration, scenes: window.__film?.scenes?.length }));
console.log('r=' + JSON.stringify(r));
console.log('logs=' + JSON.stringify(logs.slice(-10)));
await b.close();
await s.close();
