import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const query = process.argv[2] ?? 'q=low&paused&nohud';
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--enable-logging=stderr', '--v=0'] });
const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text().slice(0, 500)}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('crash', () => console.log('[page crash]'));
await page.goto(`http://127.0.0.1:4173/?${query}`);
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const st = await page.evaluate(() => ({ lost: window.__lost, frames: window.__illuminate?.state.frames })).catch((e) => ({ err: e.message }));
  console.log(i, JSON.stringify(st));
}
await browser.close();
