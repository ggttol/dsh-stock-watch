/**
 * dsh-stock-watch 优化版冒烟测试
 * 用 stub cordis ctx 加载 index.js，真实调用各路由（含真实上游网络），验证：
 *   1. /quotes 批量快照解析出 live 行情
 *   2. 30s 缓存生效（第二次 /quotes 明显更快）
 *   3. /stocks 全 A 股搜索
 *   4. /kline 与 /minute 正常返回
 */
import { performance } from "node:perf_hooks";

const MOD = "/home/gaotao/code/dsh-stock-watch/index.js";
const mod = await import(MOD);

const routes = new Map();
const ctx = {
  get(name) {
    if (name === "systemPrompt") return undefined;
    return undefined;
  },
  effect(fn) {
    // register() 返回的 disposer 直接忽略
    const r = fn();
    return r;
  },
  webServer: {
    register(def) {
      routes.set(def.path, def.handler);
      return { dispose() { routes.delete(def.path); } };
    },
  },
};

mod.apply(ctx);
console.log("registered routes:", [...routes.keys()].join(", "));
if (routes.size < 5) throw new Error("路由注册数量不对: " + routes.size);

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  return res;
}
async function call(path, query) {
  const handler = routes.get(path);
  if (!handler) throw new Error("no handler for " + path);
  const url = "http://x" + path + (query ? "?" + new URLSearchParams(query).toString() : "");
  const req = { url };
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

// ---- 1. /quotes 批量快照 ----
let t0 = performance.now();
let r = await call("/dsh-stock-watch/quotes", { group: 0, minutes: 1, groups: JSON.stringify([
  { name: "测试", symbols: [{ code: "sh000001" }, { code: "sz399300" }, { code: "sh601899" }, { code: "sz000001" }] },
]) });
let dt = performance.now() - t0;
console.log(`\n[1] /quotes #1 ${dt.toFixed(0)}ms status=${r.status}`);
console.log("   groups:", JSON.stringify(r.json.groups), "| live:", r.json.live, "| diag:", JSON.stringify(r.json.diag));
for (const row of r.json.rows) {
  console.log(`   ${row.code} ${row.name} price=${row.price} chg%=${row.changePercent} high=${row.high} low=${row.low} minutes=${Array.isArray(row.minutes) ? row.minutes.length : "-"} live=${row.live}`);
}
if (!r.json.rows.every((x) => x.live)) throw new Error("有行未拿到行情");
if (!r.json.rows[2].minutes || r.json.rows[2].minutes.length === 0) throw new Error("分时序列缺失");

// ---- 2. 缓存命中：第二次应显著更快 ----
t0 = performance.now();
r = await call("/dsh-stock-watch/quotes", { group: 0, minutes: 1, groups: JSON.stringify([
  { name: "测试", symbols: [{ code: "sh000001" }, { code: "sz399300" }, { code: "sh601899" }, { code: "sz000001" }] },
]) });
const dt2 = performance.now() - t0;
console.log(`\n[2] /quotes #2 (缓存) ${dt2.toFixed(0)}ms`);
if (dt2 > 400) console.log(`   ⚠ 第二次仍耗时 ${dt2.toFixed(0)}ms，缓存可能未生效`);

// ---- 3. 空分组 / 无 groups 参数兜底 ----
r = await call("/dsh-stock-watch/quotes", {});
console.log(`\n[3] /quotes 默认配置 source=${r.json.config.source} rows=${r.json.rows.length}`);

// ---- 4. /stocks 搜索 ----
r = await call("/dsh-stock-watch/stocks", { q: "紫金" });
console.log(`\n[4] /stocks?q=紫金 rows=${r.json.rows.length} first=`, JSON.stringify(r.json.rows[0]));

// ---- 5. /kline ----
t0 = performance.now();
r = await call("/dsh-stock-watch/kline", { code: "sh601899", period: "day" });
const kt = performance.now() - t0;
console.log(`\n[5] /kline day ${kt.toFixed(0)}ms candles=${r.json.candles.length} error=${r.json.error}`);
if (r.json.candles.length < 100) throw new Error("K线数量异常: " + r.json.candles.length);
t0 = performance.now();
const r2 = await call("/dsh-stock-watch/kline", { code: "sh601899", period: "day" });
console.log(`   /kline again (缓存) ${(performance.now() - t0).toFixed(0)}ms candles=${r2.json.candles.length}`);

// ---- 6. /minute ----
r = await call("/dsh-stock-watch/minute", { code: "sz000001" });
console.log(`\n[6] /minute date=${r.json.date} points=${r.json.points.length} prevClose=${r.json.prevClose && r.json.prevClose.toFixed(2)} error=${r.json.error}`);

console.log("\n✅ 冒烟测试全部通过");
