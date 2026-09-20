const base = process.argv[2] || process.env.NAVI_SHARE_BASE || 'https://navi-preview.app.workbuddy.host';
const urls = [
  '/',
  '/preview.html',
  '/test/ui-home.png',
  '/test/status-board-dark.png',
  '/test/status-board-light.png',
  '/test/theme-light.png',
  '/test/theme-dark.png',
  '/test/ui-login.png',
  '/test/ui-library-manage.png',
  '/test/ui-library-pick.png',
  '/test/ui-library-online.png',
  '/test/ui-library-icon-rows.png',
  '/docs/fnos-deploy-guide.html',
  '/docs/docker-guide.html',
  '/docs/image-deploy-guide.html',
  '/docs/Navi-fnOS-deploy-guide.pdf',
  '/docs/Navi-docker-deploy-guide.pdf',
  '/docs/Navi-image-deploy-guide.pdf',
];

(async () => {
  for (const u of urls) {
    try {
      const r = await fetch(base + u, { redirect: 'follow' });
      const buf = await r.arrayBuffer();
      const ct = r.headers.get('content-type') || '';
      console.log(String(r.status).padEnd(4), String(buf.byteLength).padEnd(9), ct.split(';')[0].padEnd(26), u);
    } catch (e) {
      console.log('ERR ', u, e.message);
    }
  }
})();
