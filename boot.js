// Test bootstrap: loads a preview build into a blank page and starts the reel director.
window.__load = async (sha, query) => {
  const base = 'https://raw.githubusercontent.com/sushilgr/illuminate/' + sha + '/';
  history.replaceState(null, '', '/?' + query);
  const html = await fetch(base + 'index.html').then((r) => r.text());
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const src = doc.querySelector('script[type=module]').getAttribute('src');
  const cssHref = doc.querySelector('link[rel=stylesheet]').getAttribute('href');
  document.head.innerHTML = ''; document.body.innerHTML = '';
  window.__css = await fetch(new URL(cssHref, base)).then((r) => r.text());
  const st = document.createElement('style'); st.textContent = window.__css; document.head.appendChild(st);
  [...doc.body.children].forEach((n) => { if (n.tagName !== 'SCRIPT') document.body.appendChild(document.importNode(n, true)); });
  const js = await fetch(new URL(src, base)).then((r) => r.text());
  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));
  await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
  for (let i = 0; i < 80 && !window.__illuminate; i++) await new Promise((r) => setTimeout(r, 100));
  return !!window.__illuminate;
};
window.__run = async (sha, opts, q = 'high', script = 'reel.js') => {
  if (!(await window.__load(sha, 'q=' + q + '&fresh&manual&paused&capture&time=3&mp=2.0736'))) return { failed: true, errs: window.__errs };
  await window.__illuminate.app.step(6);
  window.__reelOpts = opts;
  const src = await fetch('https://raw.githubusercontent.com/sushilgr/illuminate/' + sha + '/' + script).then((r) => r.text());
  window.__t0 = performance.now();
  new Function(src)();
  return { started: true };
};
window.__prog = () => { const R = window.__reel; return { n: R.n, sec: R.sec, done: R.done, err: R.err, mb: +(R.bytes / 1e6).toFixed(1), marks: R.marks.map((m) => m.join('@')).join(' '), thumbs: R.thumbs.length, secs: Math.round((performance.now() - window.__t0) / 1000), errs: window.__errs }; };
window.__reelSave = (name) => { const R = window.__reel; const blob = new Blob(R.chunks, { type: 'application/octet-stream' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); return { name, mb: +(blob.size / 1e6).toFixed(1), frames: R.n }; };
