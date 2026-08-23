/** v1.1.0 深度功能冒烟测试：扩展快照字段 + 五档盘口 + 分钟级K线 */
import { performance } from "node:perf_hooks";

const mod = await import("/home/gaotao/code/dsh-stock-watch/index.js");
const routes = new Map();
const ctx = {
  get() { return undefined; },
  effect(fn) { return fn(); },
  webServer: { register(def) { routes.set(def.path, def.handler); return { dispose() {} }; } },
};
mod.apply(ctx);

function makeRes() {
  return {
    statusCode: null, headers: null, body: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; },
    end(b) { this.body = b; },
  };
}
async function call(path, query) {
  const handler = routes.get(path);
  if (!handler) throw new Error("no handler for " + path);
  const req = { url: "http://x" + path + (query ? "?" + new URLSearchParams(query).toString() : "") };
  const res = makeRes();
  await handler(req, res);
  return JSON.parse(res.body);
}

// ---- 1. 扩展快照字段（股票）----
const groups = [{ name: "测试", symbols: [{ code: "sz000001" }, { code: "sh601899" }, { code: "sh000001" }] }];
let r = await call("/dsh-stock-watch/quotes", { group: 0, minutes: 1, groups: JSON.stringify(groups) });
const stock = r.rows.find((x) => x.code === "sz000001");
const idx = r.rows.find((x) => x.code === "sh000001");
console.log("[1] 股票深度字段:", JSON.stringify({
  prevClose: stock.prevClose, open: stock.open, turnoverRate: stock.turnoverRate,
  peRatio: stock.peRatio, pbRatio: stock.pbRatio, amplitude: stock.amplitude,
  floatMarketCap: stock.floatMarketCap, totalMarketCap: stock.totalMarketCap,
  limitUp: stock.limitUp, limitDown: stock.limitDown, volumeRatio: stock.volumeRatio,
}));
if (!(stock.prevClose > 0 && stock.limitUp > stock.price && stock.limitDown < stock.price)) throw new Error("涨跌停/昨收字段异常");
console.log("    五档买:", JSON.stringify(stock.bids));
console.log("    五档卖:", JSON.stringify(stock.asks));
if (stock.bids.length !== 5 || stock.asks.length !== 5) throw new Error("五档盘口缺失");
console.log("[1b] 指数(无盘口) bids/asks:", idx.bids === undefined ? "未输出(正确)" : idx.bids, "|", idx.asks === undefined ? "未输出(正确)" : idx.asks);
if (idx.bids !== undefined || idx.asks !== undefined) throw new Error("指数不应有盘口");

// ---- 2. 分钟级 K 线 ----
for (const period of ["m5", "m15", "m30", "m60"]) {
  const t0 = performance.now();
  const k = await call("/dsh-stock-watch/kline", { code: "sz000001", period });
  const dt = performance.now() - t0;
  const c = k.candles || [];
  console.log(`[2] ${period}: ${dt.toFixed(0)}ms candles=${c.length} error=${k.error} last=`, c.at(-1) && JSON.stringify({ time: c.at(-1).time, close: c.at(-1).close }));
  if (k.error || c.length < 100) throw new Error(period + " K线异常");
  if (typeof c[0].time !== "number") throw new Error(period + " time 应为 UNIX 秒");
  // 缓存命中
  const t1 = performance.now();
  await call("/dsh-stock-watch/kline", { code: "sz000001", period });
  console.log(`    ${period} 缓存命中 ${(performance.now() - t1).toFixed(1)}ms`);
}

// ---- 3. 日K回归不受影响 ----
r = await call("/dsh-stock-watch/kline", { code: "sh601899", period: "day" });
console.log("[3] day 回归:", r.candles.length, "根 | time 类型:", typeof r.candles[0].time, "(应为 string)");
if (typeof r.candles[0].time !== "string") throw new Error("日K time 类型变化");

// ---- 4. 非法周期回落 day ----
r = await call("/dsh-stock-watch/kline", { code: "sh601899", period: "h4" });
console.log("[4] 非法周期回落:", r.period, "(应为 day)");
if (r.period !== "day") throw new Error("非法周期未回落");

console.log("\n✅ v1.1.0 深度功能冒烟测试全部通过");
