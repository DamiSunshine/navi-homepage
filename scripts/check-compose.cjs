/*
 * docker-compose.yml 起飞前自检：把「缩进写歪」这类问题在启动前抓出来。
 *
 * 为什么需要它：
 *   YAML 有两种失败方式。
 *   ① 缩进不齐 → 编辑器/解析器直接报错（看得见，好办）。
 *   ② 某行缩进比同级更深 → **不报错**，而是被当成上一条的多行纯量折进去，
 *      结果是变量静默失效，值变成 "xxx - NAVI_LAN_HOST=..." 这种怪字符串。
 *      部署后表现为「变量明明设了却不生效」，极难排查。
 *   本脚本把最终解析出来的 environment 原样打印出来，②一眼可见。
 *
 * 用法：
 *   node scripts/check-compose.cjs                      # 检查项目根 docker-compose.yml
 *   node scripts/check-compose.cjs path/to/compose.yml  # 检查指定文件
 *
 * 依赖：js-yaml（本项目运行时零依赖，这只是开发/部署前的一次性自检工具）
 *   npm i -g js-yaml   或   NODE_PATH=<任意含 js-yaml 的 node_modules> node scripts/check-compose.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');

let yaml;
try {
  yaml = require('js-yaml');
} catch (e) {
  console.error('缺少依赖 js-yaml（仅自检脚本需要，运行时不依赖它）。');
  console.error('可执行：npm i -g js-yaml');
  process.exit(2);
}

const file = process.argv[2] || path.join(__dirname, '..', 'docker-compose.yml');
if (!fs.existsSync(file)) {
  console.error('文件不存在：' + file);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf-8');
let doc;
try {
  doc = yaml.load(raw);
} catch (e) {
  console.error('✗ YAML 语法错误：' + String(e.message).split('\n')[0]);
  console.error('  常见原因：同级 "-" 没有对齐在同一列；或混用了 "- 键=值" 与 "键: 值" 两种写法。');
  process.exit(1);
}
console.log('✓ YAML 语法通过：' + file);

let problems = 0;
for (const [name, svc] of Object.entries(doc.services || {})) {
  const env = svc.environment;
  if (!env) continue;
  // 统一成 [ [k, v], ... ]
  const pairs = Array.isArray(env)
    ? env.map((s) => {
        const i = String(s).indexOf('=');
        return i < 0 ? [String(s), ''] : [String(s).slice(0, i), String(s).slice(i + 1)];
      })
    : Object.entries(env).map(([k, v]) => [k, v == null ? '' : String(v)]);

  console.log('\n--- services.' + name + '.environment（共 ' + pairs.length + ' 条）---');
  for (const [k, v] of pairs) {
    // 静默折叠的特征：值里出现了 " - 全大写键=" 这样的片段
    const folded = / - [A-Z][A-Z0-9_]*=/.test(v);
    console.log((folded ? '✗ ' : '  ') + k + ' = ' + v);
    if (folded) {
      problems++;
      console.log('     ↑ 这是被折进来的下一行！该行缩进比同级更深，变量不会生效。');
    }
  }
}

if (problems) {
  console.error('\n发现 ' + problems + ' 处「静默折叠」：缩进不齐导致变量没生效。请把对应行的缩进改成与同级一致。');
  process.exit(1);
}
console.log('\n✓ 未发现缩进折叠问题。');
process.exit(0);
