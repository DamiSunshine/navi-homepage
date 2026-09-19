/*
 * 构建「线上预览与文档」静态发布包（share/）。
 * 用法：node scripts/build-share.cjs
 * 产物：share/  —— 落地页 index.html + preview.html + 真实截图 + 部署指南 HTML/PDF
 * 说明：share/ 是纯生成物，已加入 .gitignore / .dockerignore，不入库、不进镜像。
 *       改落地页请改 scripts/share-index.html（源），不要直接改 share/index.html。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'share');

// 1. 清理并创建目录
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'test'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'docs'), { recursive: true });

// 2. 落地页（源文件在 scripts/ 下，保证可重复构建）
fs.copyFileSync(path.join(ROOT, 'scripts', 'share-index.html'), path.join(OUT, 'index.html'));

// 3. 预览页
fs.copyFileSync(path.join(ROOT, 'preview.html'), path.join(OUT, 'preview.html'));

// 4. 预览页引用的 8 张真实截图
const shots = [
  'ui-home.png',
  'theme-light.png',
  'theme-dark.png',
  'ui-login.png',
  'ui-library-manage.png',
  'ui-library-pick.png',
  'ui-library-online.png',
  'ui-library-icon-rows.png',
];
let copied = 0;
for (const s of shots) {
  const src = path.join(ROOT, 'test', s);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT, 'test', s));
    copied++;
  } else {
    console.log('MISSING SHOT: ' + s);
  }
}

// 5. 部署指南 HTML
for (const h of ['docker-guide.html', 'fnos-deploy-guide.html', 'image-deploy-guide.html']) {
  fs.copyFileSync(path.join(ROOT, 'docs', h), path.join(OUT, 'docs', h));
}

// 6. 部署指南 PDF（保留中文名 + ASCII 别名，避免部分环境链接编码问题）
//    注意：用户常常正开着 PDF 照做部署，Windows 会锁文件，此时 test/make-pdf.cjs
//    会把新版另存为 xxx-new.pdf。这里主动取「较新的那一份」，避免把旧 PDF 发上线。
const pdfs = [
  ['Navi-飞牛fnOS部署指南.pdf', 'Navi-fnOS-deploy-guide.pdf'],
  ['Navi-Docker部署指南.pdf', 'Navi-docker-deploy-guide.pdf'],
  ['Navi-拉取镜像部署指南.pdf', 'Navi-image-deploy-guide.pdf'],
];
function pickNewestPdf(zh) {
  const cands = [zh, zh.replace(/\.pdf$/i, '-new.pdf')]
    .map((n) => path.join(ROOT, 'docs', n))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }));
  if (!cands.length) return null;
  cands.sort((a, b) => b.m - a.m);
  return cands[0].p;
}
for (const [zh, ascii] of pdfs) {
  const src = pickNewestPdf(zh);
  if (src) {
    fs.copyFileSync(src, path.join(OUT, 'docs', zh));
    fs.copyFileSync(src, path.join(OUT, 'docs', ascii));
    if (path.basename(src) !== zh) console.log('PDF 采用了更新版：' + path.basename(src) + ' → ' + zh);
  } else {
    console.log('MISSING PDF: ' + zh);
  }
}

console.log('screenshots copied: ' + copied + '/' + shots.length);
console.log('--- share/ tree ---');
(function walk(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      console.log(prefix + e.name + '/');
      walk(fp, prefix + '  ');
    } else {
      console.log(prefix + e.name + '  (' + fs.statSync(fp).size + ' bytes)');
    }
  }
})(OUT, '  ');
