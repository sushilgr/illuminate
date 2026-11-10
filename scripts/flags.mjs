import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const sets = {
  A: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  B: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  C: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--use-vulkan=swiftshader', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
  D: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'],
  E: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--disable-gpu-compositing', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
};
for (const [k, args] of Object.entries(sets)) {
  for (const channel of [undefined, 'chromium']) {
    let res;
    try {
      const b = await chromium.launch({ headless: true, channel, args: [...args, '--disable-gpu-watchdog'] });
      const p = await b.newPage({ viewport: { width: 320, height: 180 } });
      await p.goto('http://127.0.0.1:4173/?q=low&paused&nohud&dbg=2');
      await new Promise((r) => setTimeout(r, 2500));
      res = await p.evaluate(() => ({ lost: window.__lost ?? null, frames: window.__illuminate?.state.frames ?? null, notice: document.getElementById('notice').style.display })).catch((e) => ({ err: e.message }));
      if (res && !res.lost && res.frames) await p.screenshot({ path: `/tmp/claude-0/-home-claude/9e0f2440-67b6-5946-b6e0-e6ec89a17724/scratchpad/shots/flags_${k}_${channel ?? 'shell'}.png` });
      await b.close();
    } catch (e) { res = { launchErr: e.message.split('\n')[0] }; }
    console.log(k, channel ?? 'shell', JSON.stringify(res));
  }
}
