/* Navi 导航站 · 访问密码保护专项测试
   自动启动带认证的独立服务实例（不影响正在运行的预览服务）：
     A 实例：正常密码 + 72h 会话
     B 实例：正常密码 + 负 TTL（令牌签发即过期，验证过期拦截）
     C 实例：用户名 + 密码联合登录（requireUsername=true）
   用法：node test/auth.test.js */
"use strict";

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PASSWORD = "test-secret-123";
const USERNAME = "admin";
const PORT_A = 8641;
const PORT_B = 8642;
const PORT_C = 8643;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

function request(port, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: port, path: p, method: method, headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(port) }, extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening on")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("服务提前退出: " + code)); });
  });
}

function login(port, password) {
  return request(port, "POST", "/api/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password })
  });
}
function loginFull(port, username, password) {
  return request(port, "POST", "/api/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username, password: password })
  });
}

function extractCookie(res) {
  const sc = res.headers["set-cookie"];
  if (!sc) return null;
  const raw = Array.isArray(sc) ? sc[0] : sc;
  return raw.split(";")[0]; // navi_session=xxx
}

(async () => {
  console.log("启动测试实例 A（密码保护, TTL 72h）与 B（TTL 为负，令牌即过期）…");
  const srvA = await startServer(PORT_A, { NAVI_PASSWORD: PASSWORD });
  const srvB = await startServer(PORT_B, { NAVI_PASSWORD: PASSWORD, SESSION_TTL_HOURS: "-1" });
  const srvC = await startServer(PORT_C, { NAVI_USERNAME: USERNAME, NAVI_PASSWORD: PASSWORD });

  try {
    console.log("== 未认证拦截 ==");
    let r = await request(PORT_A, "GET", "/");
    check("GET / -> 302 跳登录页", r.status === 302 && r.headers.location === "/login.html",
      r.status + " " + r.headers.location);

    r = await request(PORT_A, "GET", "/config.json");
    check("GET /config.json -> 302（配置不可裸读）", r.status === 302, String(r.status));

    r = await request(PORT_A, "GET", "/css/style.css");
    check("GET /css/style.css -> 302（静态资源受保护）", r.status === 302, String(r.status));

    r = await request(PORT_A, "GET", "/js/app.js");
    check("GET /js/app.js -> 302（JS 受保护）", r.status === 302, String(r.status));

    r = await request(PORT_A, "GET", "/api/config");
    check("GET /api/config -> 401 JSON", r.status === 401 && JSON.parse(r.body).ok === false, String(r.status));

    console.log("== 登录页与登录流程 ==");
    r = await request(PORT_A, "GET", "/login.html");
    check("GET /login.html -> 200（登录页公开可访问）", r.status === 200 && r.body.indexOf("访问密码") !== -1);

    r = await request(PORT_A, "GET", "/api/auth/status");
    check("GET /api/auth/status -> authEnabled:true", r.status === 200 && JSON.parse(r.body).authEnabled === true);

    r = await login(PORT_A, "wrong-password");
    check("错误密码 -> 401 + 明确错误提示", r.status === 401 && JSON.parse(r.body).error.indexOf("密码错误") !== -1,
      r.status + " " + r.body);

    r = await login(PORT_A, PASSWORD);
    const cookie = extractCookie(r);
    check("正确密码 -> 200", r.status === 200 && JSON.parse(r.body).ok === true);
    check("签发会话 Cookie", !!cookie && cookie.indexOf("navi_session=") === 0);
    const setCookieRaw = Array.isArray(r.headers["set-cookie"]) ? r.headers["set-cookie"][0] : r.headers["set-cookie"];
    check("Cookie 带 HttpOnly + SameSite + Max-Age",
      /HttpOnly/i.test(setCookieRaw) && /SameSite=Lax/i.test(setCookieRaw) && /Max-Age=\d+/.test(setCookieRaw),
      setCookieRaw);

    console.log("== 会话访问 ==");
    r = await request(PORT_A, "GET", "/", { headers: { Cookie: cookie } });
    check("携带 Cookie 访问 / -> 200", r.status === 200 && r.body.indexOf("navRoot") !== -1, String(r.status));

    r = await request(PORT_A, "GET", "/api/config", { headers: { Cookie: cookie } });
    check("携带 Cookie 访问 /api/config -> 200", r.status === 200 && Array.isArray(JSON.parse(r.body).groups));

    r = await request(PORT_A, "GET", "/login.html", { headers: { Cookie: cookie } });
    check("已登录访问登录页 -> 302 回首页", r.status === 302 && r.headers.location === "/", String(r.status));

    console.log("== 伪造与过期令牌 ==");
    r = await request(PORT_A, "GET", "/", { headers: { Cookie: "navi_session=garbage" } });
    check("伪造垃圾令牌 -> 302", r.status === 302, String(r.status));

    const futureExp = Date.now() + 3600e3;
    const forged = "navi_session=" + futureExp + "." + "0".repeat(64);
    r = await request(PORT_A, "GET", "/", { headers: { Cookie: forged } });
    check("伪造合法格式但签名错误的令牌 -> 302", r.status === 302, String(r.status));

    r = await login(PORT_B, PASSWORD);
    const expiredCookie = extractCookie(r);
    r = await request(PORT_B, "GET", "/", { headers: { Cookie: expiredCookie } });
    check("过期令牌 -> 302 回登录页", r.status === 302, String(r.status));

    console.log("== 退出登录 ==");
    r = await request(PORT_A, "POST", "/api/logout", { headers: { Cookie: cookie } });
    check("POST /api/logout -> 200 且清除 Cookie",
      r.status === 200 && /Max-Age=0/.test(Array.isArray(r.headers["set-cookie"]) ? r.headers["set-cookie"][0] : r.headers["set-cookie"]));

    r = await request(PORT_A, "GET", "/", { headers: { Cookie: cookie } });
    check("登出后旧令牌被吊销 -> 302", r.status === 302, String(r.status));

    console.log("== 登录限流 ==");
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const rr = await login(PORT_B, "bad-" + i); // B 实例独立计数
      lastStatus = rr.status;
    }
    check("连续错误 5 次后第 6 次 -> 429 限流", lastStatus === 429, String(lastStatus));

    console.log("== C 实例：用户名 + 密码联合登录 ==");
    r = await request(PORT_C, "GET", "/api/auth/status");
    check("C: auth/status 返回 requireUsername:true",
      r.status === 200 && JSON.parse(r.body).requireUsername === true, r.body);

    r = await request(PORT_C, "GET", "/login.html");
    check("C: 登录页含用户名字段",
      r.status === 200 && r.body.indexOf('id="username"') !== -1 && r.body.indexOf("用户名") !== -1,
      String(r.status));

    r = await loginFull(PORT_C, USERNAME, PASSWORD);
    const cookieC = extractCookie(r);
    check("C: 正确用户名 + 正确密码 -> 200 并签发 Cookie",
      r.status === 200 && JSON.parse(r.body).ok === true && !!cookieC, r.status + " " + r.body);

    r = await loginFull(PORT_C, USERNAME, "wrong-pass");
    check("C: 正确用户名 + 错误密码 -> 401",
      r.status === 401 && JSON.parse(r.body).error.indexOf("用户名或密码错误") !== -1,
      r.status + " " + r.body);

    r = await loginFull(PORT_C, "bad-user", PASSWORD);
    check("C: 错误用户名 + 正确密码 -> 401（不区分错误项，防枚举）", r.status === 401, r.status + " " + r.body);

    r = await login(PORT_C, PASSWORD); // 启用了用户名维度，仅密码视为缺用户名
    check("C: 启用用户名后仅密码(缺用户名) -> 401", r.status === 401, r.status + " " + r.body);

    r = await request(PORT_C, "GET", "/api/config", { headers: { Cookie: cookieC } });
    check("C: 联合登录后可访问 /api/config -> 200", r.status === 200 && Array.isArray(JSON.parse(r.body).groups), String(r.status));
  } finally {
    srvA.kill();
    srvB.kill();
    if (srvC) srvC.kill();
  }

  console.log("");
  console.log("结果：" + passed + " 通过, " + failed + " 失败");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
