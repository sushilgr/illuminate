// Headless capture for development checks (software WebGPU via SwiftShader; slow but faithful).
// Usage: node scripts/shot.mjs <out.png> "<query string>" [frames] [width] [height] ["js to run before stepping"]
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';

const [out = 'shot.png', query = 'q=tiny', frames = '6', w = '480', h = '270', pre = ''] = process.argv.slice(2);
const base = process.env.URL ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-watchdog'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${base}?${query}&capture&manual&paused`);
const t0 = Date.now();
let info = {};
try {
  await page.waitForFunction(() => window.__illuminate || document.getElementById('notice').style.display === 'grid', null, { timeout: 60000 });
  info = await page.evaluate(async ([n, pre]) => {
    const s = window.__illuminate;
    if (!s) return { notice: document.getElementById('notice').innerText };
    if (pre) await (new Function('s', `return (async () => { ${pre} })()`))(s);
    const t = performance.now();
    await s.step(n);
    const dt = (performance.now() - t) / n;
    await s.capture();
    return { frames: s.state.frames, msPerFrame: Math.round(dt), lost: window.__lost };
  }, [Number(frames), pre]);
} catch (e) { logs.push('[script] ' + e.message.split('\n')[0]); }
await page.screenshot({ path: out });
console.log(JSON.stringify({ ms: Date.now() - t0, ...info }));
console.log([...new Set(logs)].filter((l) => !l.includes('THREE.Clock')).slice(0, 30).join('\n'));
await browser.close();
