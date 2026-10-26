import { chromium } from '@playwright/test';
import fs from 'fs';
const plan = JSON.parse(fs.readFileSync('/tmp/crawl.json')).map(r => ({ user: r.user, mobile: r.mobile, href: r.href, mod: r.mod.replace('m-asterdata','masterdata') }));
const W = +(process.env.W || 4); const out = [];
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP *.smes.example.com 127.0.0.1'] });
const base = 'http://tenant-a.smes.example.com:8080';
async function session(user, mobile) {
  const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true } : { viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(base + '/login'); await p.fill('#login-username', user); await p.fill('#login-password', 'demo-password');
  await p.getByRole('button', { name: '登录' }).click(); await p.waitForTimeout(2000);
  return { ctx, p };
}
const groups = {}; for (const r of plan) (groups[r.user + '|' + r.mobile] ??= []).push(r);
const keys = Object.keys(groups); let gi = 0;
async function worker() {
  while (gi < keys.length) {
    const k = keys[gi++]; const [user, m] = k.split('|'); const mobile = m === 'true';
    const { ctx, p } = await session(user, mobile);
    for (const r of groups[k]) {
      const net = [], con = [];
      const onR = x => { if (x.status() >= 400) net.push(`${x.status()} ${new URL(x.url()).pathname}`); };
      const onC = x => { if (x.type() === 'error') con.push(x.text().slice(0, 120)); };
      p.on('response', onR); p.on('console', onC);
      let ok = true, txt = '', err = null;
      try { if (r.href.startsWith('/m')) { await p.goto(base + '/m'); await p.waitForTimeout(1200); } else { await p.goto(base + '/'); await p.waitForTimeout(1200); }
        if (r.href !== '/' && r.href !== '/m') { const a = p.locator(`a[href="${r.href}"]`).first(); if (await a.count()) await a.click(); else await p.evaluate(h => { history.pushState({}, '', h); dispatchEvent(new PopStateEvent('popstate')); }, r.href); }
        await p.waitForTimeout(1800); txt = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
        if (/出错|Internal server error|未捕获/.test(txt) || net.some(n => n.startsWith('5'))) ok = false; } catch (e) { ok = false; err = String(e).slice(0, 150); }
      const dir = `/workspace/retest-541ffff/shots/${r.mod}`; fs.mkdirSync(dir, { recursive: true });
      const shot = `${dir}/${user}-${mobile ? 'mobile' : 'desktop'}-${r.href.replace(/[^\w]/g, '_')}.png`;
      try { await p.screenshot({ path: shot, fullPage: true }); } catch {}
      p.off('response', onR); p.off('console', onC);
      out.push({ ...r, ok, net: [...new Set(net)], con: [...new Set(con)].slice(0, 5), txt, err, shot });
    }
    await ctx.close();
  }
}
await Promise.all(Array.from({ length: W }, worker));
fs.writeFileSync('/workspace/retest-541ffff/raw/crawl.json', JSON.stringify(out, null, 1));
console.log('done', out.length, out.filter(x => x.ok).length); await b.close();
