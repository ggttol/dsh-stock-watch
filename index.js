/**
 * dsh-stock-watch — node 端
 *
 * cordis 插件：在 dsh web 服务器上注册 /dsh-stock-watch/* 路由：
 *   - /dsh-stock-watch/config   GET 读取 / POST 保存 ~/.stocking/settings.json（服务器为唯一数据源，多端一致）
 *   - /dsh-stock-watch/quotes   按分组拉取实时行情（qt.gtimg.cn 批量快照 + 分时缓存迷你折线）
 *   - /dsh-stock-watch/kline    日/周/月 K 线（fqkline 接口，前复权，30s 缓存）
 *   - /dsh-stock-watch/minute   分时详情（分钟点 + 昨收，30s 缓存）
 *
 * 浏览器端（client.js）通过 fetch 消费这些路由。
 * 数据源与原 stocking CLI 的 market.ts 同源：腾讯财经。
 * 性能：/quotes 把 N 只股票的行情合并为 ⌈N/50⌉ 个批量请求；分时/K线/配置均有 TTL 缓存。
 */
import { homedir } from "node:os";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const name = "dsh-stock-watch";
/** Required services: webServer（HTTP 路由）。 */
const inject = ["webServer"];

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const STOCKS_PATH = join(MODULE_DIR, "data", "a_stocks.json");
const SKILLS_SRC_DIR = join(MODULE_DIR, "skills");
/** 自选股配置文件（服务器唯一数据源；客户端 localStorage 只是缓存）。 */
const SETTINGS_PATH = join(homedir(), ".stocking", "settings.json");
/** 安装时注入到用户技能目录的技能（与「一键分析」提示词引用的技能保持一致）。 */
const BUNDLED_SKILLS = ["investment-research", "frontend-design"];

// ---------------------------------------------------------------------------
// 技能注入：安装插件（首次启动 dsh web）时把自带技能复制到用户技能目录
// ~/.agents/skills/<name>/，让「一键分析」引用的技能真正可用（此前只是随包文件）。
// - 目标已存在 SKILL.md 则跳过，尊重用户已有/自定义版本（删除后重启可重新注入）
// - 可用环境变量覆盖：DSH_STOCK_WATCH_SKILLS_DIR（目标目录）、DSH_STOCK_WATCH_NO_SKILLS=1（禁用）
// ---------------------------------------------------------------------------
function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else copyFileSync(s, d);
  }
}

function ensureUserSkills() {
  if (process.env.DSH_STOCK_WATCH_NO_SKILLS === "1") return;
  const skillsRoot = process.env.DSH_STOCK_WATCH_SKILLS_DIR || join(homedir(), ".agents", "skills");
  for (const skill of BUNDLED_SKILLS) {
    const src = join(SKILLS_SRC_DIR, skill);
    const dest = join(skillsRoot, skill);
    try {
      if (existsSync(join(dest, "SKILL.md"))) continue; // 已存在：尊重用户版本，不覆盖
      if (!existsSync(join(src, "SKILL.md"))) continue; // 包内缺失（本地开发可能没拷）：跳过
      copyDirSync(src, dest);
      writeFileSync(
        join(dest, "_user_meta.json"),
        JSON.stringify({ name: skill, installedAt: Date.now(), source: "dsh-stock-watch" }, null, 2),
      );
      console.log(`[dsh-stock-watch] 已注入技能 ${skill} -> ${dest}`);
    } catch (e) {
      console.error(`[dsh-stock-watch] 技能 ${skill} 注入失败:`, e && e.message ? e.message : e);
    }
  }
}

let stocksCache = null;

// ---------------------------------------------------------------------------
// 扇形菜单注入提示词（不直接暴露：客户端只发送「每日复盘/行情分析/涨停分析」几个字，
// 完整提示词由系统提示条件式注入——仅当用户消息匹配对应关键词时生效）
// ---------------------------------------------------------------------------
const FAN_PROMPTS = {
  每日复盘: `请作为专业的A股短线复盘分析师，帮我完成今天的盘后复盘。请基于以下框架：

1. 市场概览：指数表现、成交量变化、涨跌家数分布。不要只报数据，要点出"这说明什么"。

2. 涨停梯队：今日涨停多少家？炸板多少家？连板高度到几板了？首板、二板、三板各多少？晋级率如何？

3. 主线与轮动：今天市场围绕哪些方向在交易？哪些是主线、哪些只是轮动？哪些方向冲高回落？

4. 情绪判断：今天的情绪是在加强、分化、修复还是退潮？赚钱效应如何？

5. 核心个股反馈：龙头股、中军股的表现如何？从它们的走势能看出什么？

6. 明日关键观察：明天最需要盯住的变量是什么？不要只说"关注市场变化"，要说具体看什么指标。

输出格式用7个板块，每个板块一句话结论。要有明确判断，不要模棱两可。`,
  行情分析: `获取A股实时行情数据，给出整体分析：

市场温度：当前是进攻还是防守格局？一句话定性。

量价关系：放量还是缩量？量价是否配合？说明什么？

结构分化：大小盘风格如何？哪些板块在领涨/领跌？

操作基调：此刻适合积极、谨慎还是观望？给明确结论。
输出要求：每项不超过两行，总字数控制在200字以内。`,
  涨停分析: `基于今日涨停数据（涨停家数、连板高度、炸板率、涨停板块分布），分析：

情绪热度（亢奋/正常/冰点）

主线板块（涨停最集中方向）

龙头高度及晋级情况

明天接力风险或机会
每项一句话，总字数控制在150字以内。`,
};

const MINUTE_API = "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}&r=0.1";
const KLINE_API = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,,{count},qfq";
/** 分钟级 K 线（5/15/30/60 分钟）：注意主机是 ifzq.gtimg.cn（web.ifzq 会 301） */
const MKLINE_API = "https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={code},{period},,{count}";
const INTRADAY_COUNT = "320";
const INTRADAY_PERIODS = new Set(["m5", "m15", "m30", "m60"]);
const KLINE_PERIODS = ["day", "week", "month", "m5", "m15", "m30", "m60"];

const DEFAULT_GROUPS = [
  { name: "分组1", symbols: [{ code: "sh000001" }, { code: "sz399300" }, { code: "sh601899" }] },
  { name: "分组2", symbols: [] },
];

// ---------------------------------------------------------------------------
// 配置读取与容错清洗（与 stocking/src/settings.ts 语义一致）
// ---------------------------------------------------------------------------

/** 只接受正数价格，其余视为未配置 */
function normalizePrice(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function normalizeSymbol(raw) {
  if (typeof raw === "string") return { code: raw };
  if (!raw || typeof raw !== "object") return null;
  const o = raw;
  if (typeof o.code !== "string" || o.code.length === 0) return null;
  const s = { code: o.code };
  if (typeof o.name === "string" && o.name.trim()) s.name = o.name.trim();
  const buy = normalizePrice(o.buyPrice);
  if (buy !== undefined) s.buyPrice = buy;
  const sell = normalizePrice(o.sellPrice);
  if (sell !== undefined) s.sellPrice = sell;
  return s;
}

function normalizeGroup(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 32) : "未命名分组";
  const symbols = [];
  const seen = new Set();
  if (Array.isArray(raw.symbols)) {
    for (const item of raw.symbols) {
      const sym = normalizeSymbol(item);
      if (!sym || seen.has(sym.code)) continue;
      seen.add(sym.code);
      symbols.push(sym);
    }
  }
  return { name, symbols };
}

/** 客户端 localStorage 配置（清洗 + 跨组去重） */
function normalizeClientGroups(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const g = normalizeGroup(item);
    if (!g) continue;
    g.symbols = g.symbols.filter((s) => {
      if (seen.has(s.code)) return false;
      seen.add(s.code);
      return true;
    });
    out.push(g);
  }
  return out.length > 0 ? out : null;
}

async function readGroupsFile(path) {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    const groups = [];
    const seen = new Set();
    if (Array.isArray(parsed?.groups)) {
      for (const item of parsed.groups) {
        const group = normalizeGroup(item);
        if (!group) continue;
        group.symbols = group.symbols.filter((s) => {
          if (seen.has(s.code)) return false;
          seen.add(s.code);
          return true;
        });
        groups.push(group);
      }
    } else if (Array.isArray(parsed?.symbols)) {
      // v1 扁平结构 → 内存迁移为单分组
      const group = { name: "分组1", symbols: [] };
      const localSeen = new Set();
      for (const item of parsed.symbols) {
        const sym = normalizeSymbol(item);
        if (!sym || localSeen.has(sym.code)) continue;
        localSeen.add(sym.code);
        group.symbols.push(sym);
      }
      groups.push(group);
    }
    if (groups.length > 0) return { groups, source: "file", path };
  } catch {
    /* 读取/解析失败 → 兜底默认分组 */
  }
  return { groups: DEFAULT_GROUPS, source: "default", path: null };
}

/** settings.json 按 mtime 缓存：轮询高频调用时不再每次重读+重析文件；外部改文件（mtime 变化）自动失效 */
let groupsCache = null; // { mtimeMs, loaded }

async function loadGroups() {
  const path = SETTINGS_PATH;
  let mtimeMs = -1;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    mtimeMs = -1; // 文件不存在
  }
  if (groupsCache && groupsCache.mtimeMs === mtimeMs) return groupsCache.loaded;
  const loaded = await readGroupsFile(path);
  groupsCache = { mtimeMs, loaded };
  return loaded;
}

/**
 * 保存客户端上报的分组配置到 ~/.stocking/settings.json（原子写：tmp + rename）。
 * 复用 normalizeClientGroups 做清洗（价格/名称规范化 + 跨组去重）。
 * @returns {Promise<Array|null>} 清洗后的分组；输入无效时返回 null
 */
async function saveGroups(rawGroups) {
  const groups = normalizeClientGroups(rawGroups);
  if (!groups) return null;
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  const payload = JSON.stringify({ groups, updatedAt: Date.now() }, null, 2) + "\n";
  const tmp = SETTINGS_PATH + ".tmp";
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, SETTINGS_PATH);
  groupsCache = null; // 立即失效缓存，下次读取强制重读
  return groups;
}

// ---------------------------------------------------------------------------
// 腾讯财经接口（与 stocking/src/market.ts 同源）
// ---------------------------------------------------------------------------

function normalizeApiCode(code) {
  // 带市场前缀的代码原样透传——此前 hk/us 代码会被错误拼成 shhk…/shus…，
  // 导致港美股 K 线与分时全部「无K线数据」
  if (/^(sh|sz|bj|hk|us)[0-9a-z.]+$/i.test(code)) return code;
  if (/^(60|68|51)/.test(code)) return "sh" + code;
  if (/^(00|30|39)/.test(code)) return "sz" + code;
  // 北交所数字代码（43/83/87/92 开头）
  if (/^(43|83|87|92)/.test(code)) return "bj" + code;
  return "sh" + code;
}

/** 股票池：data/a_stocks.json（全 A 股 {code, name}，惰性加载并缓存；兼容 BOM） */
async function loadStocks() {
  if (stocksCache) return stocksCache;
  try {
    const text = await readFile(STOCKS_PATH, "utf8");
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const parsed = JSON.parse(clean);
    stocksCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    stocksCache = [];
  }
  return stocksCache;
}

/** 上游请求统一带 UA/Referer：腾讯接口对无头请求偶发限流，带浏览器头更稳 */
const UPSTREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://gu.qq.com/",
};

/** GBK 解码器：qt.gtimg.cn 批量快照为 GBK 编码；官方 Node（full-ICU）可用，缺失则回退旧路径 */
let gbkDecoder = null;
try {
  gbkDecoder = new TextDecoder("gbk");
} catch {
  gbkDecoder = null;
}

async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: UPSTREAM_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = 12000, encoding = "utf-8") {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: UPSTREAM_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return encoding === "utf-8" ? new TextDecoder("utf-8").decode(buf) : gbkDecoder.decode(buf);
}

// ---------------------------------------------------------------------------
// 快照批量拉取：qt.gtimg.cn/q=sh000001,sz399300,... 一次请求返回全部快照，
// 字段序与 minute/query 响应里的 qt 数组完全一致（[1]名 [3]价 [6]量 [31]涨跌
// [32]涨跌% [33]高 [34]低 [37]额(万)）。把 /quotes 的 N 个上游请求合并为 ⌈N/50⌉ 个。
// ---------------------------------------------------------------------------
const SNAPSHOT_API = "https://qt.gtimg.cn/q=";
const SNAPSHOT_CHUNK = 50;

function numField(fields, i) {
  if (i >= fields.length) return null;
  const v = parseFloat(fields[i]);
  return Number.isFinite(v) ? v : null;
}

/** 五档买卖盘：fields 9-18 买一~买五价量，19-28 卖一~卖五价量；指数无盘口 → 空数组 */
function parseLevels(fields, baseIndex) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const p = numField(fields, baseIndex + i * 2);
    const v = numField(fields, baseIndex + i * 2 + 1);
    if (p !== null && v !== null && p > 0) out.push({ p, v });
  }
  return out;
}

function parseSnapshotLine(apiCode, fields) {
  if (!Array.isArray(fields) || fields.length < 38) return null;
  const price = parseFloat(fields[3]);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    code: apiCode,
    name: String(fields[1] ?? ""),
    price,
    changeAmount: parseFloat(fields[31] ?? "0"),
    changePercent: parseFloat(fields[32] ?? "0"),
    high: parseFloat(fields[33] ?? "0"),
    low: parseFloat(fields[34] ?? "0"),
    volume: parseInt(fields[6] ?? "0", 10),
    amount: parseFloat(fields[37] ?? "0") * 10000,
    // —— 深度行情扩展字段（同一响应，零额外请求；缺失/指数场景为 null） ——
    prevClose: numField(fields, 4),         // 昨收
    open: numField(fields, 5),              // 今开
    turnoverRate: numField(fields, 38),     // 换手率 %
    peRatio: numField(fields, 39),          // 市盈率 TTM
    amplitude: numField(fields, 43),        // 振幅 %
    floatMarketCap: numField(fields, 44),   // 流通市值(亿)
    totalMarketCap: numField(fields, 45),   // 总市值(亿)
    pbRatio: numField(fields, 46),          // 市净率
    limitUp: numField(fields, 47),          // 涨停价
    limitDown: numField(fields, 48),        // 跌停价
    volumeRatio: fields.length > 49 ? numField(fields, 49) : null, // 量比
    bids: parseLevels(fields, 9),           // 买一~买五 [{p,v}]
    asks: parseLevels(fields, 19),          // 卖一~卖五 [{p,v}]
  };
}

/** 批量拉取快照，返回 Map<apiCode, quote>；单批失败只丢该批（行显示为不在线），不整体抛错 */
async function fetchSnapshots(apiCodes) {
  const out = new Map();
  if (gbkDecoder === null || apiCodes.length === 0) return out;
  const chunks = [];
  for (let i = 0; i < apiCodes.length; i += SNAPSHOT_CHUNK) chunks.push(apiCodes.slice(i, i + SNAPSHOT_CHUNK));
  const texts = await Promise.all(
    chunks.map((c) => fetchText(SNAPSHOT_API + c.join(","), 8000, "gbk").catch(() => "")),
  );
  for (const text of texts) {
    if (!text) continue;
    for (const line of text.split(";")) {
      const m = line.match(/v_([a-z]{2}\d+)="([^"]*)"/);
      if (!m) continue;
      const quote = parseSnapshotLine(m[1], m[2].split("~"));
      if (quote) out.set(m[1], quote);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 分时 JSON 缓存（30s TTL）：分时序列每分钟才新增一个点，
// 列表迷你折线（10s 轮询）与详情页（10s 轮询）共享缓存后，单只股票上游请求 ≤1 次/30s。
// ---------------------------------------------------------------------------
const MINUTE_TTL_MS = 30000;
const MINUTE_CACHE_MAX = 300;
const minuteJsonCache = new Map(); // apiCode -> { at, json }

async function fetchMinuteJsonCached(apiCode) {
  const hit = minuteJsonCache.get(apiCode);
  const now = Date.now();
  if (hit && now - hit.at < MINUTE_TTL_MS) return hit.json;
  let json = null;
  try {
    json = await fetchJson(MINUTE_API.replace("{code}", apiCode));
  } catch {
    json = null; // 失败也短暂缓存，避免上游抖动时每轮轮询都打满超时
  }
  if (minuteJsonCache.size >= MINUTE_CACHE_MAX) {
    const oldest = minuteJsonCache.keys().next().value;
    minuteJsonCache.delete(oldest);
  }
  minuteJsonCache.set(apiCode, { at: now, json });
  return json;
}

/** 从 minute/query 响应提取分时价格序列 */
function extractMinutePrices(json, apiCode) {
  if (!json || json.code !== 0) return [];
  const sd = json.data && json.data[apiCode];
  if (!sd) return [];
  const raw = sd.data && sd.data.data;
  const prices = [];
  if (Array.isArray(raw)) {
    for (const line of raw) {
      const parts = String(line).split(" ");
      if (parts.length >= 2) {
        const p = parseFloat(parts[1]);
        if (Number.isFinite(p)) prices.push(p);
      }
    }
  }
  return prices;
}

/** 解析单只股票的分钟接口响应（快照 + 可选分时价格） */
function parseMinuteJson(code, json, includeMinutes) {
  if (!json || json.code !== 0) return { quote: null, prices: [] };
  const apiCode = normalizeApiCode(code);
  const sd = json.data && json.data[apiCode];
  if (!sd) return { quote: null, prices: [] };
  const prices = includeMinutes ? extractMinutePrices(json, apiCode) : [];
  const qt = sd.qt && sd.qt[apiCode];
  if (Array.isArray(qt) && qt.length >= 35) {
    return {
      quote: {
        code,
        name: String(qt[1] ?? ""),
        price: parseFloat(qt[3] ?? "0"),
        changeAmount: parseFloat(qt[31] ?? "0"),
        changePercent: parseFloat(qt[32] ?? "0"),
        high: parseFloat(qt[33] ?? "0"),
        low: parseFloat(qt[34] ?? "0"),
        volume: parseInt(qt[6] ?? "0", 10),
        amount: parseFloat(qt[37] ?? "0") * 10000,
      },
      prices,
    };
  }
  return { quote: null, prices };
}

/**
 * 单只股票行情：快照优先取批量结果（0 额外请求）；
 * 需要 分时迷你折线 时走 30s 缓存的分时接口；批量缺失时回退旧的单只解析路径。
 */
async function fetchQuoteResult(symbol, includeMinutes, snapshotMap) {
  const apiCode = normalizeApiCode(symbol.code);
  let prices = [];
  let minuteJson = null;
  if (includeMinutes) {
    minuteJson = await fetchMinuteJsonCached(apiCode);
    prices = extractMinutePrices(minuteJson, apiCode);
  }
  const snap = snapshotMap ? snapshotMap.get(apiCode) : undefined;
  if (snap) return { quote: { ...snap, code: symbol.code }, prices };
  if (minuteJson === null) minuteJson = await fetchMinuteJsonCached(apiCode);
  return parseMinuteJson(symbol.code, minuteJson, false);
}

function computeTrigger(price, buyPrice, sellPrice) {
  if (buyPrice === undefined && sellPrice === undefined) return "none";
  if (sellPrice !== undefined && price >= sellPrice) return "sell";
  if (buyPrice !== undefined && price <= buyPrice) return "buy";
  return "wait";
}

/** K 线缓存（30s TTL）：详情页 10s 轮询日/周/月 K 时不再每次打上游 */
const KLINE_TTL_MS = 30000;
const KLINE_CACHE_MAX = 200;
const klineCache = new Map(); // "apiCode:period" -> { at, result }

async function fetchKline(code, period, refPrice) {
  const apiCode = normalizeApiCode(code);
  const cacheKey = apiCode + ":" + period;
  const hit = klineCache.get(cacheKey);
  if (hit && Date.now() - hit.at < KLINE_TTL_MS) return hit.result;
  const result = await fetchKlineUpstream(apiCode, period, refPrice);
  if (klineCache.size >= KLINE_CACHE_MAX) {
    const oldest = klineCache.keys().next().value;
    klineCache.delete(oldest);
  }
  klineCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

async function fetchKlineUpstream(apiCode, period, refPrice) {
  // 分钟级 K 线（m5/m15/m30/m60）：mkline 接口，行 [YYYYMMDDHHmm, open, close, high, low, vol]，
  // time 转为 UNIX 秒（Lightweight Charts 日内轴要求）
  if (INTRADAY_PERIODS.has(period)) {
    const url = MKLINE_API.replace("{code}", apiCode).replace("{period}", period).replace("{count}", INTRADAY_COUNT);
    try {
      const json = await fetchJson(url);
      if (!json || json.code !== 0) return { candles: [], error: "接口返回异常" };
      const sd = json.data && json.data[apiCode];
      const rows = sd && Array.isArray(sd[period]) ? sd[period] : null;
      if (!rows) return { candles: [], error: "无K线数据" };
      const candles = [];
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const dt = String(row[0]);
        const iso = dt.length === 12
          ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(8, 10)}:${dt.slice(10, 12)}:00+08:00`
          : "";
        const t = iso ? Math.round(Date.parse(iso) / 1000) : 0;
        const open = parseFloat(row[1]);
        const close = parseFloat(row[2]);
        const high = parseFloat(row[3]);
        const low = parseFloat(row[4]);
        if (!t || !Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
        candles.push({ time: t, open, high, low, close, volume: parseFloat(row[5]) || 0 });
      }
      if (candles.length === 0) return { candles: [], error: "无K线数据" };
      return { candles, error: null };
    } catch {
      return { candles: [], error: "行情获取失败" };
    }
  }
  const count = period === "day" ? "160" : "120";
  const url = KLINE_API.replace("{code}", apiCode).replace("{period}", period).replace("{count}", count);
  try {
    const json = await fetchJson(url);
    if (!json || json.code !== 0) return { candles: [], error: "接口返回异常" };
    const sd = json.data && json.data[apiCode];
    if (!sd) return { candles: [], error: "无K线数据" };
    const keys = period === "day"
      ? ["qfqday", "day", "hfqday"]
      : period === "week" ? ["qfqweek", "week", "hfqweek"] : ["qfqmonth", "month", "hfqmonth"];
    let rows = null;
    for (const k of keys) {
      if (Array.isArray(sd[k])) { rows = sd[k]; break; }
    }
    if (!rows) return { candles: [], error: "无K线数据" };
    const candles = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const time = String(row[0]);
      const open = parseFloat(row[1]);
      const close = parseFloat(row[2]);
      const high = parseFloat(row[3]);
      const low = parseFloat(row[4]);
      if (!time || Number.isNaN(open) || Number.isNaN(close) || Number.isNaN(high) || Number.isNaN(low)) continue;
      candles.push({ time, open, high, low, close, volume: parseFloat(row[5]) || 0 });
    }
    if (candles.length === 0) return { candles: [], error: "无K线数据" };
    // 自校正（实测列序 [date, open, close, high, low, volume] 正确，仅作保险）
    if (typeof refPrice === "number" && Number.isFinite(refPrice) && refPrice > 0) {
      const last = candles[candles.length - 1];
      if (last && Math.abs(last.low - refPrice) < Math.abs(last.close - refPrice)) {
        for (const c of candles) {
          const close = c.low;
          const high = c.close;
          const low = c.high;
          c.close = close;
          c.high = high;
          c.low = low;
        }
      }
    }
    return { candles, error: null };
  } catch {
    return { candles: [], error: "行情获取失败" };
  }
}

async function fetchMinuteDetail(code) {
  const apiCode = normalizeApiCode(code);
  try {
    const json = await fetchMinuteJsonCached(apiCode);
    if (!json || json.code !== 0) return { date: null, prevClose: null, points: [], error: "接口返回异常" };
    const sd = json.data && json.data[apiCode];
    if (!sd || !sd.data) return { date: null, prevClose: null, points: [], error: "无分时数据" };
    const raw = sd.data.data;
    const date = typeof sd.data.date === "string" ? sd.data.date : "";
    const isoDate = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : "";
    const points = [];
    if (Array.isArray(raw)) {
      for (const line of raw) {
        const parts = String(line).split(" ");
        if (parts.length < 3) continue;
        const hm = parts[0];
        const p = parseFloat(parts[1]);
        const v = parseFloat(parts[2]) || 0;
        if (!/^\d{4}$/.test(hm) || Number.isNaN(p)) continue;
        let t = 0;
        if (isoDate) {
          const ms = Date.parse(`${isoDate}T${hm.slice(0, 2)}:${hm.slice(2, 4)}:00+08:00`);
          if (!Number.isNaN(ms)) t = Math.round(ms / 1000);
        }
        if (t <= 0) continue;
        points.push({ t, p, v });
      }
    }
    let prevClose = null;
    const qt = sd.qt && sd.qt[apiCode];
    if (Array.isArray(qt) && qt.length >= 35) {
      const price = parseFloat(qt[3] ?? "0");
      const chg = parseFloat(qt[32] ?? "0");
      if (price > 0 && Number.isFinite(chg)) prevClose = price / (1 + chg / 100);
    }
    if (points.length === 0) return { date, prevClose, points: [], error: "无分时数据" };
    return { date, prevClose, points, error: null };
  } catch {
    return { date: null, prevClose: null, points: [], error: "行情获取失败" };
  }
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function queryOf(req) {
  return new URL(req.url ?? "/", "http://x").searchParams;
}

/**
 * 插件主体：注册 /dsh-stock-watch/* 路由。
 * @param {import("cordis").Context} ctx
 */
function apply(ctx) {
  // 安装/启动时把自带技能注入用户技能目录（幂等：已有则跳过）
  try {
    ensureUserSkills();
  } catch (e) {
    console.error("[dsh-stock-watch] 技能注入异常:", e && e.message ? e.message : e);
  }

  const register = (path, handler) =>
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler }), `dsh-stock-watch: ${path}`);

  // ---- AI 持仓建议引擎（确定性量化内核）----
  // ---------------------------------------------------------------------------
  // AI 持仓建议引擎（确定性量化内核）：技术指标 + 关键位推导 + 市场环境 + 新闻聚合。
  // 设计原则：数值部分全部本地确定性计算（可解释、零延迟）；叙事判断交给 DSH 会话模型。
  // ---------------------------------------------------------------------------
  const ADVICE_CACHE_MAX = 24;
  const adviceCache = new Map(); // apiCode -> { at, result }
  const ADVICE_TTL_MS = 5 * 60 * 1000;

  const NEWS_CACHE_MAX = 48;
  const newsCache = new Map(); // "news:bare6"/"ann:bare6" -> { at, items }
  const NEWS_TTL_MS = 10 * 60 * 1000;

  const ENV_CODES = ["sh000001", "sz399001", "sz399006"];
  const ENV_NAMES = { sh000001: "上证指数", sz399001: "深证成指", sz399006: "创业板指" };

  function smaLast(vals, n) {
    if (!Array.isArray(vals) || vals.length < n) return null;
    let sum = 0;
    for (let i = vals.length - n; i < vals.length; i++) sum += vals[i];
    return sum / n;
  }

  function emaArr(vals, n) {
    const k = 2 / (n + 1);
    const out = [];
    let prev = vals[0];
    for (let i = 0; i < vals.length; i++) {
      prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function macdOf(closes) {
    if (closes.length < 35) return null;
    const e12 = emaArr(closes, 12);
    const e26 = emaArr(closes, 26);
    const dif = e12.map((v, i) => v - e26[i]);
    const dea = emaArr(dif, 9);
    const i = closes.length - 1;
    return { dif: dif[i], dea: dea[i], hist: (dif[i] - dea[i]) * 2, prevHist: (dif[i - 1] - dea[i - 1]) * 2 };
  }

  function rsiLast(closes, period = 14) {
    if (closes.length < period + 2) return null;
    let ag = 0, al = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) ag += d; else al -= d;
    }
    ag /= period; al /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
  }

  function atrLast(candles, period = 14) {
    if (candles.length < period + 1) return null;
    let atr = null;
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      atr = atr === null ? tr : (atr * (period - 1) + tr) / period;
    }
    return atr;
  }

  function kdjLast(candles) {
    if (candles.length < 9) return null;
    let k = 50, d = 50;
    for (let i = 8; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - 8; j <= i; j++) { hh = Math.max(hh, candles[j].high); ll = Math.min(ll, candles[j].low); }
      const rsv = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
      k = (k * 2 + rsv) / 3;
      d = (d * 2 + k) / 3;
    }
    return { k, d, j: 3 * k - 2 * d };
  }

  function bollLast(closes, n = 20, mult = 2) {
    const mid = smaLast(closes, n);
    if (mid === null) return null;
    let sq = 0;
    for (let i = closes.length - n; i < closes.length; i++) sq += (closes[i] - mid) ** 2;
    const sd = Math.sqrt(sq / n);
    return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
  }

  function r2(v) {
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  }

  /** 快照解析（本文件内专用精简版）：fields 序与 qt.gtimg 一致 */
  function snapFields(fields) {
    return {
      name: typeof fields[1] === "string" ? fields[1] : "",
      price: numField(fields, 3),
      prevClose: numField(fields, 4),
      changePct: numField(fields, 32),
      turnover: numField(fields, 38),
      pe: numField(fields, 39),
      amp: numField(fields, 43),
      floatCap: numField(fields, 44),
      cap: numField(fields, 45),
      pb: numField(fields, 46),
      volumeRatio: numField(fields, 49),
    };
  }

  async function fetchSnapshots(codes) {
    try {
      const txt = await fetchText(SNAPSHOT_API + codes.join(","), 8000, "gbk");
      const map = {};
      for (const line of txt.split(";")) {
        const m = /v_(\w+)="([^"]*)"/.exec(line);
        if (!m) continue;
        map[m[1]] = snapFields(m[2].split("~"));
      }
      return map;
    } catch {
      return {};
    }
  }

  async function fetchStockNews(bare6, name) {
    const key = "news:" + bare6;
    const hit = newsCache.get(key);
    if (hit && Date.now() - hit.at < NEWS_TTL_MS) return hit.items;
    let items = [];
    try {
      const param = encodeURIComponent(JSON.stringify({
        uid: "", keyword: name, type: ["cmsArticleWebOld"], client: "web", clientType: "web", clientVersion: "curr",
        param: { cmsArticleWebOld: { searchScope: "default", sort: "time", pageIndex: 1, pageSize: 4, preTag: "", postTag: "" } },
      }));
      const txt = await fetchText("https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=" + param, 8000);
      const m = /x\(([\s\S]*)\)\s*;?\s*$/.exec(txt);
      const arts = m && JSON.parse(m[1]).result.cmsArticleWebOld || [];
      items = arts.map((a) => ({
        title: String(a.title || "").replace(/<[^>]+>/g, "").slice(0, 60),
        date: String(a.date || "").slice(5, 10),
      })).filter((x) => x.title);
    } catch { items = []; }
    if (newsCache.size >= NEWS_CACHE_MAX) newsCache.delete(newsCache.keys().next().value);
    newsCache.set(key, { at: Date.now(), items });
    return items;
  }

  async function fetchAnnouncements(bare6) {
    const key = "ann:" + bare6;
    const hit = newsCache.get(key);
    if (hit && Date.now() - hit.at < NEWS_TTL_MS) return hit.items;
    let items = [];
    try {
      const j = await fetchJson("https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=4&page_index=1&ann_type=A&stock_list=" + bare6, 8000);
      items = (((j || {}).data || {}).list || []).map((a) => ({
        title: String(a.title || "").replace(/<[^>]+>/g, "").slice(0, 60),
        date: String(a.notice_date || "").slice(5, 10),
      })).filter((x) => x.title);
    } catch { items = []; }
    if (newsCache.size >= NEWS_CACHE_MAX) newsCache.delete(newsCache.keys().next().value);
    newsCache.set(key, { at: Date.now(), items });
    return items;
  }

  async function buildAdvice(apiCode, refPrice) {
    // 1) 日线（含缓存）
    const kl = await fetchKlineUpstream(apiCode, "day", refPrice);
    const candles = Array.isArray(kl.candles) ? kl.candles : [];
    if (candles.length < 40) return { ok: false, error: "K线数据不足（" + candles.length + " 根）" };
    const closes = candles.map((c) => c.close);
    const close = closes[closes.length - 1];

    // 2) 快照：个股 + 大盘三指数
    const snaps = await fetchSnapshots([apiCode, ...ENV_CODES]);
    const q = snaps[apiCode] || {};

    // 3) 指标
    const ma = {};
    for (const n of [5, 10, 20, 60]) ma[n] = r2(smaLast(closes, n));
    const macd = macdOf(closes);
    const rsi = rsiLast(closes);
    const atr = atrLast(candles);
    const kdj = kdjLast(candles);
    const boll = bollLast(closes);
    const vol5 = smaLast(candles.slice(-5).map((c) => c.volume), 5);
    const vol20 = smaLast(candles.slice(-20).map((c) => c.volume), 20);

    // 4) 关键位：近期摆动高低点 + 布林轨道
    const last10 = candles.slice(-10), last20 = candles.slice(-20);
    const swingLow = Math.min(...last10.map((c) => c.low));
    const swingHigh20 = Math.max(...last20.map((c) => c.high));
    const atrV = Number.isFinite(atr) && atr > 0 ? atr : close * 0.02;
    let support2 = Math.min(swingLow, boll ? boll.lower : swingLow);
    let support1 = Math.min(swingLow, close - 1.2 * atrV);
    if (support1 <= support2) support1 = support2 + 0.3 * atrV;
    let resistance1 = boll ? boll.upper : close + 1.5 * atrV;
    if (resistance1 <= close) resistance1 = close + 1.5 * atrV;
    let resistance2 = Math.max(swingHigh20, close + 3 * atrV);
    if (resistance2 <= resistance1) resistance2 = resistance1 + atrV;

    // 5) 评分（-100..+100，每项带权重，全部可解释）
    let score = 0;
    const reasons = [];
    const mas = [ma[5], ma[10], ma[20], ma[60]];
    let aboveCnt = mas.filter((v) => v !== null && close > v).length;
    score += aboveCnt * 6 - (4 - aboveCnt) * 4; // ±24
    if (aboveCnt === 4) reasons.push("均线多头排列");
    else if (aboveCnt === 0) reasons.push("均线下方弱势");
    if (macd) {
      if (macd.dif > macd.dea) { score += 12; reasons.push("MACD 零轴上金叉状态"); }
      else { score -= 12; reasons.push("MACD 死叉运行"); }
      if (macd.hist > macd.prevHist) { score += 5; reasons.push("红柱放大动能增强"); }
      else if (macd.hist < 0 && macd.hist < macd.prevHist) { score -= 5; reasons.push("绿柱放大动能走弱"); }
    }
    if (Number.isFinite(rsi)) {
      if (rsi >= 70) { score -= 6; reasons.push("RSI 超买 (" + Math.round(rsi) + ")"); }
      else if (rsi <= 30) { score += 8; reasons.push("RSI 超卖 (" + Math.round(rsi) + ")"); }
      else if (rsi > 55) { score += 6; reasons.push("RSI 强势区 (" + Math.round(rsi) + ")"); }
      else if (rsi < 45) { score -= 4; reasons.push("RSI 弱势区 (" + Math.round(rsi) + ")"); }
    }
    if (kdj) {
      if (kdj.k > kdj.d && kdj.j < 105) score += 7; else if (kdj.k < kdj.d) score -= 5;
      if (kdj.j > 110) { score -= 4; reasons.push("KDJ 高位钝化风险"); }
    }
    if (boll) {
      if (close > boll.mid) score += 6; else score -= 4;
      if (close > boll.upper) { score -= 5; reasons.push("触及布林上轨"); }
      else if (close < boll.lower) { score += 5; reasons.push("触及布林下轨"); }
    }
    if (Number.isFinite(vol5) && Number.isFinite(vol20) && vol20 > 0) {
      const ratio = vol5 / vol20;
      if (ratio > 1.2 && close > (ma[5] || close)) { score += 6; reasons.push("量能温和放大"); }
      else if (ratio > 1.3 && close < (ma[5] || close)) { score -= 8; reasons.push("放量下跌"); }
    }

    // 6) 评级与操作建议
    score = Math.max(-100, Math.min(100, Math.round(score)));
    let rating, action, stance;
    if (score >= 45) { rating = "偏多"; action = "持有/持股待涨，回踩支撑可加"; stance = "bullish"; }
    else if (score >= 18) { rating = "谨慎偏多"; action = "持有为主，突破阻力再加仓"; stance = "cautious-bull"; }
    else if (score > -18) { rating = "中性观望"; action = "区间思路：接近支撑轻仓、接近阻力减仓"; stance = "neutral"; }
    else if (score > -45) { rating = "谨慎偏空"; action = "反弹减仓，破位离场"; stance = "cautious-bear"; }
    else { rating = "偏空"; action = "规避/空头思路，反抽不站回 MA20 不接"; stance = "bearish"; }

    // 7) 止损止盈（多头参考系；ATR 自适应 + 结构位优先）
    const weak = close < (ma[20] || close);
    const stopRaw = weak ? close - 1.2 * atrV : Math.max(swingLow - 0.25 * atrV, close - 2.2 * atrV);
    const stop = r2(Math.min(stopRaw, close - 0.8 * atrV));
    const tp1 = r2(Math.max(resistance1, close + 1.5 * atrV));
    const tp2 = r2(Math.max(resistance2, close + 3 * atrV));
    const riskPerShare = Math.max(close - stop, 0.01);
    const rr = r2((tp1 - close) / riskPerShare);

    // 8) 市场环境
    const env = [];
    let envScore = 0;
    for (const code of ENV_CODES) {
      const s = snaps[code];
      if (!s || !Number.isFinite(s.price)) continue;
      env.push({ code, name: ENV_NAMES[code] || code, price: s.price, changePct: s.changePct });
    }
    // 大盘用日线 MA20 位置粗判风偏
    for (const code of ENV_CODES) {
      try {
        const ek = await fetchKlineUpstream(code, "day", null);
        const ec = (ek.candles || []).map((c) => c.close);
        const m20 = smaLast(ec, 20);
        if (m20 !== null && ec[ec.length - 1] > m20) envScore += 1;
        else envScore -= 1;
      } catch { /* 单指数失败不影响整体 */ }
    }
    const envLabel = envScore >= 2 ? "偏暖（多数指数在 MA20 上方）" : envScore <= -2 ? "偏冷（多数指数在 MA20 下方）" : "震荡分化";

    // 9) 新闻与公告（尽力而为）
    const bare6 = (/(?:^|[^0-9])([0-9]{6})$/.exec(apiCode) || [])[1] || "";
    const name = q.name || "";
    const [news, anns] = await Promise.all([
      bare6 && name ? fetchStockNews(bare6, name.replace(/\s+/g, "")) : Promise.resolve([]),
      bare6 ? fetchAnnouncements(bare6) : Promise.resolve([]),
    ]);

    return {
      ok: true,
      code: apiCode,
      name,
      price: close,
      changePct: q.changePct ?? null,
      pe: q.pe ?? null,
      pb: q.pb ?? null,
      turnover: q.turnover ?? null,
      volumeRatio: q.volumeRatio ?? null,
      floatCap: q.floatCap ?? null,
      indicators: {
        ma, macd: macd ? { dif: r2(macd.dif), dea: r2(macd.dea), hist: r2(macd.hist) } : null,
        rsi: Number.isFinite(rsi) ? Math.round(rsi * 10) / 10 : null,
        kdj: kdj ? { k: Math.round(kdj.k * 10) / 10, d: Math.round(kdj.d * 10) / 10, j: Math.round(kdj.j * 10) / 10 } : null,
        boll: boll ? { upper: r2(boll.upper), mid: r2(boll.mid), lower: r2(boll.lower) } : null,
        atr: r2(atrV),
        volRatio520: Number.isFinite(vol5) && Number.isFinite(vol20) && vol20 > 0 ? Math.round((vol5 / vol20) * 100) / 100 : null,
      },
      levels: { support1: r2(support1), support2: r2(support2), resistance1: r2(resistance1), resistance2: r2(r2(resistance2)), stop, tp1, tp2, rr },
      verdict: { score, rating, action, stance, reasons: reasons.slice(0, 5) },
      marketEnv: { items: env, label: envLabel, score: envScore },
      news, announcements: anns,
      generatedAt: Date.now(),
      disclaimer: "量化参考由本地指标引擎生成，非投资建议；仓位与止损请结合自身风险承受能力。",
    };
  }

  async function adviceFor(apiCode, refPrice) {
    const hit = adviceCache.get(apiCode);
    if (hit && Date.now() - hit.at < ADVICE_TTL_MS) return hit.result;
    let result;
    try {
      result = await buildAdvice(apiCode, refPrice);
    } catch (e) {
      result = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (adviceCache.size >= ADVICE_CACHE_MAX) adviceCache.delete(adviceCache.keys().next().value);
    adviceCache.set(apiCode, { at: Date.now(), result });
    return result;
  }

  register("/dsh-stock-watch/config", async (req, res) => {
    // POST：客户端把分组配置保存到服务器（任意浏览器/设备打开都是同一份）
    if (req.method === "POST") {
      let body = "";
      let overflow = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) {
          overflow = true;
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (overflow) return; // 连接已被销毁
        let parsed;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
          return;
        }
        try {
          const groups = await saveGroups(parsed.groups);
          if (!groups) {
            sendJson(res, 400, { ok: false, error: "无效的分组配置" });
            return;
          }
          sendJson(res, 200, { ok: true, groups, updatedAt: Date.now() });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      });
      return;
    }
    // GET：返回服务器配置；source === "file" 表示存在真实配置，"default" 表示尚无（客户端可反向迁移上传）
    const loaded = await loadGroups();
    sendJson(res, 200, {
      groups: loaded.groups,
      source: loaded.source,
      path: loaded.path,
      serverManaged: true,
    });
  });

  // 添加股票搜索：按代码或名称匹配全 A 股池，返回带市场前缀的代码
  register("/dsh-stock-watch/stocks", async (req, res) => {
    const needle = (queryOf(req).get("q") ?? "").trim();
    if (!needle) {
      sendJson(res, 200, { rows: [] });
      return;
    }
    const lower = needle.toLowerCase();
    const list = await loadStocks();
    const rows = [];
    for (const s of list) {
      if (s.code.includes(lower) || (s.name && s.name.toLowerCase().includes(lower))) {
        rows.push({ code: normalizeApiCode(s.code), name: s.name });
        if (rows.length >= 50) break;
      }
    }
    sendJson(res, 200, { rows, total: rows.length });
  });

  register("/dsh-stock-watch/quotes", async (req, res) => {
    try {
      const q = queryOf(req);
      const groupIndex = parseInt(q.get("group") ?? "0", 10) || 0;
      const includeMinutes = q.get("minutes") === "1";
      let loaded;
      const groupsParam = q.get("groups");
      if (groupsParam) {
        try {
          const clientGroups = normalizeClientGroups(JSON.parse(groupsParam));
          loaded = clientGroups ? { groups: clientGroups, source: "local", path: null } : await loadGroups();
        } catch {
          loaded = await loadGroups();
        }
      } else {
        loaded = await loadGroups();
      }
      const groups = loaded.groups;
      const safeIdx = groups.length > 0 ? Math.min(groupIndex, groups.length - 1) : 0;
      const group = groups[safeIdx] || groups[0] || null;
      const symbols = group ? group.symbols : [];
      // 批量快照：全部股票合并为 ⌈N/50⌉ 个上游请求（原先每只股票一个）
      let snapshotMap = new Map();
      try {
        snapshotMap = await fetchSnapshots(symbols.map((s) => normalizeApiCode(s.code)));
      } catch {
        snapshotMap = new Map(); // 批量失败 → fetchQuoteResult 自动回退旧的单只路径
      }
      const results = await Promise.all(symbols.map((s) => fetchQuoteResult(s, includeMinutes, snapshotMap)));
      const rows = [];
      let live = 0;
      let firstError = null;
      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const parsed = results[i] ?? { quote: null, prices: [] };
        if (!parsed.quote && !firstError) firstError = "拉取失败";
        const q2 = parsed.quote;
        const row = {
          code: sym.code,
          name: q2 ? q2.name : sym.name || sym.code,
          trigger: "none",
          live: false,
        };
        if (sym.buyPrice !== undefined) row.buyPrice = sym.buyPrice;
        if (sym.sellPrice !== undefined) row.sellPrice = sym.sellPrice;
        if (q2) {
          live += 1;
          row.live = true;
          row.price = q2.price;
          row.changePercent = q2.changePercent;
          row.changeAmount = q2.changeAmount;
          row.high = q2.high;
          row.low = q2.low;
          row.volume = q2.volume;
          row.amount = q2.amount;
          // 深度行情扩展字段（批量快照同源；旧回退路径没有这些字段 → 缺省不写）
          for (const k of [
            "prevClose", "open", "turnoverRate", "peRatio", "amplitude",
            "floatMarketCap", "totalMarketCap", "pbRatio", "limitUp", "limitDown", "volumeRatio",
          ]) {
            if (q2[k] !== null && q2[k] !== undefined) row[k] = q2[k];
          }
          if (Array.isArray(q2.bids) && q2.bids.length > 0) row.bids = q2.bids;
          if (Array.isArray(q2.asks) && q2.asks.length > 0) row.asks = q2.asks;
          row.trigger = computeTrigger(q2.price, sym.buyPrice, sym.sellPrice);
          if (includeMinutes && parsed.prices && parsed.prices.length > 0) row.minutes = parsed.prices;
        }
        rows.push(row);
      }
      sendJson(res, 200, {
        groups: groups.map((g) => ({ name: g.name, count: g.symbols.length })),
        groupIndex: safeIdx,
        rows,
        live: live > 0,
        updatedAt: Date.now(),
        config: { source: loaded.source, path: loaded.path },
        diag: { firstError },
      });
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  });

  register("/dsh-stock-watch/advice", async (req, res) => {
    const q = queryOf(req);
    const code = q.get("code") ?? "";
    if (!code) { sendJson(res, 400, { ok: false, error: "缺少股票代码" }); return; }
    const refRaw = parseFloat(q.get("refPrice") ?? "");
    const refPrice = Number.isFinite(refRaw) && refRaw > 0 ? refRaw : null;
    const result = await adviceFor(normalizeApiCode(code), refPrice);
    sendJson(res, 200, result);
  });

  register("/dsh-stock-watch/kline", async (req, res) => {
    const q = queryOf(req);
    const code = q.get("code") ?? "";
    const rawPeriod = q.get("period");
    const period = KLINE_PERIODS.includes(rawPeriod) ? rawPeriod : "day";
    const refRaw = parseFloat(q.get("refPrice") ?? "");
    const refPrice = Number.isFinite(refRaw) && refRaw > 0 ? refRaw : null;
    if (!code) {
      sendJson(res, 400, { code, period, candles: [], error: "缺少股票代码", updatedAt: Date.now() });
      return;
    }
    const result = await fetchKline(code, period, refPrice);
    sendJson(res, 200, { code, period, candles: result.candles, error: result.error, updatedAt: Date.now() });
  });

  register("/dsh-stock-watch/minute", async (req, res) => {
    const q = queryOf(req);
    const code = q.get("code") ?? "";
    if (!code) {
      sendJson(res, 400, { code, date: null, prevClose: null, points: [], error: "缺少股票代码", updatedAt: Date.now() });
      return;
    }
    const result = await fetchMinuteDetail(code);
    sendJson(res, 200, {
      code,
      date: result.date,
      prevClose: result.prevClose,
      points: result.points,
      error: result.error,
      updatedAt: Date.now(),
    });
  });

  // 一键分析配套：客户端只发送简短消息「分析{公司名}（代码）」，这里注入一条条件式系统指令，
  // 保证任何会话中出现「分析某家公司」类请求时，依次使用 investment-research / frontend-design 两个技能。
  // 条件式措辞：仅对分析上市公司的请求生效，其它对话不受影响。
  const sp = typeof ctx.get === "function" ? ctx.get("systemPrompt") : undefined;
  if (sp) {
    ctx.effect(
      () => sp.section({
        name: "dsh-stock-watch.analysis",
        order: 200,
        text: "两类股票插件请求按不同流程处理：\n"
          + "① 当用户消息以「分析」开头、且意图是分析某家上市公司（而非代码、思路等其他对象）时：依次使用技能 investment-research 完成投资研究分析，再使用技能 frontend-design 生成一个介绍该公司的网站。\n"
          + "② 当用户消息包含「【AI持仓研判】」标记时：这是股票插件详情页发来的富上下文研判请求——消息内已含本地量化引擎算出的技术指标/关键位/止损止盈参考/市场环境与新闻标题。此类请求【不要生成网站】，直接输出结构化持仓研判：一、核心结论（持有/减仓/回避 + 置信度%）；二、止损线与止盈线的具体价位及触发逻辑（可基于消息中的量化参考修正，但须说明依据）；三、未来两周关键观察点；四、主要风险因素。结合消息内新闻标题自行补充基本面判断，可调用 investment-research 技能。",
      }),
      "dsh-stock-watch: analysis prompt section",
    );

    // 扇形菜单注入：客户端只发送「每日复盘/行情分析/涨停分析」几个字，
    // 完整提示词在此条件式注入——仅当用户消息匹配对应关键词时按框架执行。
    ctx.effect(
      () => sp.section({
        name: "dsh-stock-watch.fan-prompts",
        order: 201,
        text: "当用户消息为「每日复盘」或以「每日复盘」开头时，执行以下每日复盘任务：\n"
          + FAN_PROMPTS.每日复盘
          + "\n当用户消息为「行情分析」或以「行情分析」开头时，执行以下行情分析任务：\n"
          + FAN_PROMPTS.行情分析
          + "\n当用户消息为「涨停分析」或以「涨停分析」开头时，执行以下涨停分析任务：\n"
          + FAN_PROMPTS.涨停分析,
      }),
      "dsh-stock-watch: fan prompt section",
    );
  }
}

export { apply, inject, name, ensureUserSkills };
