/*
 * compose 文件起飞前自检：把「缩进写歪」和「安全护栏被拆掉」在启动前抓出来。
 *
 * 为什么需要它：
 *   YAML 有两种失败方式。
 *   ① 缩进不齐 → 编辑器/解析器直接报错（看得见，好办）。
 *   ② 某行缩进比同级更深 → **不报错**，而是被当成上一条的多行纯量折进去，
 *      结果是变量静默失效，值变成 "xxx - NAVI_LAN_HOST=..." 这种怪字符串。
 *      部署后表现为「变量明明设了却不生效」，极难排查。
 *   本脚本把最终解析出来的 environment 原样打印出来，②一眼可见。
 *
 *   除此之外还检查两条「护栏」——它们被拆掉不会报错，但会让部署悄悄变差：
 *   ③ NAVI_PASSWORD 必须用 ${NAVI_PASSWORD:?…} 强制校验。
 *      写成 ${NAVI_PASSWORD:-…} 或缺省为空时，compose 会静默退化成
 *      「无密码开放访问」——站点变成任何人可编辑。
 *   ④ docker-compose.image.yml 里不能有 build:。
 *      它一旦出现，compose 就会转去本地构建，「拉预构建镜像」这条路静默失效。
 *
 * 用法：
 *   node scripts/check-compose.cjs                      # 检查根目录全部 docker-compose*.yml
 *   node scripts/check-compose.cjs path/to/compose.yml  # 只检查指定文件
 *
 * 退出码：0 = 全部通过 / 1 = 发现问题 / 2 = 环境或文件问题（如缺 js-yaml）
 *
 * 依赖：js-yaml（本项目运行时零依赖，这只是开发/部署前的一次性自检工具）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ---------- js-yaml 解析（多路径兜底，避免"装了却找不到"） ---------- */
function loadYaml() {
  try {
    return require('js-yaml');
  } catch (e) { /* 继续找 */ }
  const candidates = [
    process.env.NAVI_JS_YAML_DIR,
    // 本机受管 Node 工作区（本项目开发环境里 js-yaml 装在这里）
    'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules',
    path.join(ROOT, 'node_modules'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      return require(path.join(dir, 'js-yaml'));
    } catch (e) { /* 继续找 */ }
  }
  return null;
}

const yaml = loadYaml();
if (!yaml) {
  console.error('缺少依赖 js-yaml（仅自检脚本需要，运行时不依赖它）。');
  console.error('任选一种方式解决：');
  console.error('  · npm i -g js-yaml');
  console.error('  · NODE_PATH=<含 js-yaml 的 node_modules> node scripts/check-compose.cjs');
  console.error('  · NAVI_JS_YAML_DIR=<含 js-yaml 的目录> node scripts/check-compose.cjs');
  process.exit(2);
}

/* ---------- 待检查文件清单 ---------- */
const arg = process.argv[2];
let files;
if (arg) {
  files = [arg];
} else {
  files = fs.readdirSync(ROOT)
    .filter((n) => /^docker-compose.*\.ya?ml$/i.test(n))
    .sort()
    .map((n) => path.join(ROOT, n));
}
if (!files.length) {
  console.error('没有找到任何 docker-compose*.yml');
  process.exit(2);
}
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error('文件不存在：' + f);
    process.exit(2);
  }
}

/* ---------- 逐文件检查 ---------- */
let problems = 0;
function bad(msg) {
  problems++;
  console.log('  ✗ ' + msg);
}

// 是不是「纯拉取」编排：文件名里带 .image. 就按这条规则要求
function isImageOnly(file) {
  return /\.image\./i.test(path.basename(file));
}

function envPairs(env) {
  if (!env) return [];
  return Array.isArray(env)
    ? env.map((s) => {
        const i = String(s).indexOf('=');
        return i < 0 ? [String(s), ''] : [String(s).slice(0, i), String(s).slice(i + 1)];
      })
    : Object.entries(env).map(([k, v]) => [k, v == null ? '' : String(v)]);
}

for (const file of files) {
  const rel = path.relative(ROOT, file) || file;
  console.log('');
  console.log('================ ' + rel + ' ================');

  const raw = fs.readFileSync(file, 'utf-8');
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    console.log('  ✗ YAML 语法错误：' + String(e.message).split('\n')[0]);
    console.log('    常见原因：同级 "-" 没有对齐在同一列；或混用了 "- 键=值" 与 "键: 值" 两种写法。');
    problems++;
    continue;
  }
  console.log('  ✓ YAML 语法通过');

  const services = doc && doc.services ? doc.services : {};
  const names = Object.keys(services);
  if (!names.length) {
    bad('没有解析出任何 services —— 文件结构不对');
    continue;
  }

  for (const name of names) {
    const svc = services[name] || {};
    console.log('  --- services.' + name + ' ---');

    /* ③ + ④ ：逐服务检查 */
    if (svc.build !== undefined && isImageOnly(file)) {
      bad('services.' + name + ' 含有 build: —— 本文件是"纯拉取"编排，' +
          'compose 会转去本地构建，「直接拉镜像」这条路就静默失效了。请删掉 build:');
    }

    const hasImage = typeof svc.image === 'string';
    console.log('     image  = ' + (hasImage ? svc.image : '(未设置)'));
    if (isImageOnly(file) && !hasImage) {
      bad('services.' + name + ' 没有 image: —— 纯拉取编排必须指明远程镜像地址');
    }
    if (isImageOnly(file) && hasImage && !/[a-z0-9-]+\.[a-z]{2,}\//i.test(svc.image)) {
      // 带仓库主机的地址必然含一个"点"（ghcr.io/…），否则就是本地镜像名
      bad('services.' + name + ' 的 image 看起来不是远程仓库地址（' + svc.image +
          '）：compose 只会去本地找它，pull 不下来');
    }

    const pairs = envPairs(svc.environment);
    if (pairs.length) {
      console.log('     environment（共 ' + pairs.length + ' 条）：');
      for (const [k, v] of pairs) {
        const folded = / - [A-Z][A-Z0-9_]*=/.test(v);
        console.log('       ' + (folded ? '✗ ' : '') + k + ' = ' + v);
        if (folded) {
          bad(k + ' 的值里折进了下一行 —— 该行缩进比同级更深，变量不会生效');
        }
      }
    }

    // 密码护栏：只在设了 NAVI_PASSWORD 时检查
    const pw = pairs.filter(([k]) => k === 'NAVI_PASSWORD').map(([, v]) => v);
    for (const v of pw) {
      if (/^\$\{NAVI_PASSWORD:-/.test(v)) {
        bad('NAVI_PASSWORD 用了 `${NAVI_PASSWORD:-…}`（冒号减号）：变量缺失时会**静默**取默认值，' +
            '站点可能变成无密码开放访问。应改为 `${NAVI_PASSWORD:?报错信息}`');
      } else if (!/^\$\{NAVI_PASSWORD:\?/.test(v)) {
        bad('NAVI_PASSWORD 不是 `${NAVI_PASSWORD:?…}` 强制校验形式（当前值：' + v + '）。' +
            '若是明文密码，请移入已被忽略的 .env');
      }
    }

    // 整目录挂载铁律
    const vols = Array.isArray(svc.volumes) ? svc.volumes.map(String) : [];
    // 容器内路径以 /app/data 开头的都算"数据目录挂载"（含把单个 config.json 挂进去的错误写法）
    const dataMounts = vols.filter((v) => /:\/app\/data(\/|$)/.test(v));
    if (!dataMounts.length) {
      console.log('     ⚠ 未把数据目录挂到 /app/data —— 容器内数据不会持久化到宿主机');
    }
    for (const v of dataMounts) {
      const parts = v.split(':');
      const host = parts[0] || '';
      console.log('     volume = ' + v);
      if (/config\.json$/i.test(host)) {
        bad('把单个 config.json 挂进了 /app/data（' + v + '）：这是单文件挂载，' +
            '写配置会走跨挂载点 rename，在飞牛等平台触发 EBUSY 保存失败。应改为整目录挂载 ./data:/app/data');
      } else if (parts[1] !== '/app/data') {
        bad('数据目录的容器内路径应为 /app/data，实际是 ' + parts[1] + '（' + v + '）');
      }
    }
  }
}

/* ---------- 汇总 ---------- */
console.log('');
if (problems) {
  console.error('发现 ' + problems + ' 处问题。');
  console.error('  · 缩进折叠 → 把对应行的缩进改成与同级一致');
  console.error('  · build: 混在纯拉取编排里 → 删掉 build:，只留 image:');
  console.error('  · 密码护栏 → 用 ${NAVI_PASSWORD:?NAVI_PASSWORD is required, please set it in .env}');
  process.exit(1);
}
console.log('✓ 全部通过（' + files.length + ' 个文件）：未发现缩进折叠、护栏缺失或编排冲突。');
process.exit(0);
