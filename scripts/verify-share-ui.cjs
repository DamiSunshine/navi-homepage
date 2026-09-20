/* 线上交付物验证：落地页 / 预览页 / 文档页 是否真正可用（含截图实际解码）

   用法：
     NODE_PATH=<含 playwright 的 node_modules> node scripts/verify-share-ui.cjs
     NODE_PATH=<...> node scripts/verify-share-ui.cjs http://127.0.0.1:8640   # 验证本地 share/

   ⚠️ 默认校验的是**已发布的线上站**，因此「发布前先用本地 share/ 跑一遍」是更省事的工作流：
     发布才发现问题 = 把旧内容留在线上多待一轮。 */
const path = require('path');
const { chromium } = require('playwright');

// 优先命令行参数，其次环境变量，最后回落到线上地址
const BASE = process.argv[2] || process.env.NAVI_SHARE_BASE || 'https://navi-preview.app.workbuddy.host';
const OUT = 'E:/workbuddy存储空间/导航站/test';
const fails = [];
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fails.push(m); console.log('  ✗ ' + m); };

(async () => {
  const browser = await chromium.launch();

  // ---------- 1. 落地页 ----------
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const resp = await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  console.log('[1] 落地页');
  resp && resp.status() === 200 ? ok('HTTP 200') : bad('HTTP ' + (resp && resp.status()));
  (await page.title()).includes('Navi') ? ok('标题：' + (await page.title())) : bad('标题异常');

  const cardCount = await page.locator('.card').count();
  cardCount === 5 ? ok('卡片数 = 5 (预览 / fnOS / Docker / 拉取镜像 / PDF)') : bad('卡片数 = ' + cardCount);

  // 落地页上的所有链接都应有 200/正常响应
  const links = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  for (const href of links) {
    if (/^(#|data:)/.test(href)) continue;
    const r = await page.request.get(new URL(href, BASE + '/').href);
    r.status() === 200 ? ok('链接可达 ' + href) : bad('链接 ' + href + ' → ' + r.status());
  }

  await page.screenshot({ path: path.join(OUT, 'share-landing.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(OUT, 'share-landing-dark.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  // 移动端不溢出
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  overflow <= 1 ? ok('移动端无横向滚动') : bad('移动端横向溢出 ' + overflow + 'px');
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---------- 2. 预览页 ----------
  console.log('[2] 预览测试页');
  await page.goto(BASE + '/preview.html', { waitUntil: 'networkidle' });
  await page.locator('#shots').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  const shots = await page.locator('#shotGrid img').evaluateAll((imgs) =>
    imgs.map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight }))
  );
  shots.length === 10 ? ok('截图卡片 10 张') : bad('截图卡片 ' + shots.length + ' 张');
  const broken = shots.filter((s) => !s.w || s.w < 10);
  broken.length === 0 ? ok('全部截图真实解码成功') : bad('截图未解码：' + broken.map((b) => b.src).join(', '));
  await page.screenshot({ path: path.join(OUT, 'share-preview-shots.png') });

  // ---------- 3. 文档页 ----------
  console.log('[3] 部署文档');
  for (const d of ['/docs/fnos-deploy-guide.html', '/docs/docker-guide.html', '/docs/image-deploy-guide.html']) {
    await page.goto(BASE + d, { waitUntil: 'domcontentloaded' });
    const h = await page.locator('h1, h2').first().innerText().catch(() => '');
    h.trim().length > 0 ? ok(d + ' → ' + h.trim().slice(0, 26)) : bad(d + ' 无标题');
  }
  await page.goto(BASE + '/docs/fnos-deploy-guide.html', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, 'share-fnos-guide.png'), fullPage: false });

  // ---------- 4. 内容新鲜度（防止把旧包发上线） ----------
  // 只看 HTTP 200 抓不到「发了旧内容」，这里校验本次改动的关键标记。
  console.log('[4] 内容新鲜度');
  const markers = [
    ['/', ['<b>16</b> 套', '701'], ['435', '427', '355', '348', '333', '325', '317']],
    ['/preview.html', ['701', '非安全上下文', 'checkdeploy.test.cjs', 'imagecompose.test.cjs', 'SSE4.2', 'ui-status.test.cjs', 'zipbackup.test.js', 'status.test.js', 'status-board-dark.png'], ['435', '427', '355', '348', '333', '325', '317']],
    ['/docs/fnos-deploy-guide.html', ['导入自己刚导出的备份', '重建容器时要不要清空这个目录', '确认新代码真的生效', 'ghcr.io'], []],
    ['/docs/docker-guide.html', ['关于「完整性校验失败」', '701', 'check-deploy.cjs', 'docker-compose.image.yml', 'SSE4.2'], ['435', '427', '355', '348', '333', '325']],
    ['/docs/image-deploy-guide.html', ['docker-compose.image.yml', 'ghcr.io', 'linux/arm64', 'config.json', 'Change package visibility', 'SSE4.2', 'SELinux'], []],
  ];
  for (const [url, musts, mustNots] of markers) {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    const miss = musts.filter((m) => !html.includes(m));
    const stale = mustNots.filter((m) => html.includes(m));
    if (!miss.length && !stale.length) ok(url + ' 内容为最新');
    else bad(url + (miss.length ? ' 缺少：' + miss.join('/') : '') + (stale.length ? ' 残留旧值：' + stale.join('/') : ''));
  }

  await browser.close();
  console.log('\n' + (fails.length ? 'FAILED (' + fails.length + '):\n- ' + fails.join('\n- ') : 'ALL CHECKS PASSED'));
  process.exit(fails.length ? 1 : 0);
})();
