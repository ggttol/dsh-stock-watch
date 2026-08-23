#!/usr/bin/env node
/** 从插件源码提取建议引擎及其依赖，独立跑通并验证数值合理性 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/home/gaotao/.dsh/profiles/web/node_modules/dsh-stock-watch/index.js';
const src = readFileSync(SRC, 'utf8');

function topLevel(name, kind = 'function') {
  // 提取顶层 function/const 定义块（列 0 起）
  const re = kind === 'function'
    ? new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm')
    : new RegExp(`^${name} = [^;\\n]+;`, 'm');
  const m = src.match(re);
  if (!m) throw new Error('未找到顶层定义: ' + name);
  return m[0];
}

const parts = [];
// 多行 const 块（对象/集合字面量）：从声明行截到第一个 `};` 或行尾分号
function topBlock(startRe, endMarker = '};') {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      const out = [lines[i]];
      if (lines[i].trimEnd().endsWith(';')) return lines[i];
      for (let j = i + 1; j < lines.length; j++) {
        out.push(lines[j]);
        if (lines[j].trim() === endMarker) return out.join('\n');
      }
    }
  }
  throw new Error('块未找到: ' + startRe);
}
parts.push(topBlock(/^const UPSTREAM_HEADERS = \{/));
parts.push('let gbkDecoder = null; try { gbkDecoder = new TextDecoder("gbk"); } catch {}');
parts.push('const SNAPSHOT_API = "https://qt.gtimg.cn/q=";');
parts.push('const klineCache = new Map();');
parts.push(src.match(/^const KLINE_API = .*$/m)[0]);
parts.push(src.match(/^const MKLINE_API = .*$/m)[0]);
parts.push(src.match(/^const INTRADAY_PERIODS = .*$/m)[0]);
parts.push(topLevel('fetchJson'));
parts.push(topLevel('fetchText'));
parts.push(topLevel('numField'));
parts.push(topLevel('normalizeApiCode'));
parts.push(topLevel('fetchKlineUpstream'));

// 引擎块：apply 内 2 空格缩进 → 去缩进
const em = src.match(/  \/\/ ---- AI 持仓建议引擎[\s\S]*?async function adviceFor[\s\S]*?\n  \}/);
if (!em) throw new Error('引擎块提取失败');
parts.push(em[0].replace(/^  /gm, '').replaceAll('window.__skLog', 'globalThis.__skLog'));

parts.push('\nexport { buildAdvice, fetchSnapshots, fetchStockNews };');
writeFileSync('/home/gaotao/.dsh/profiles/web/node_modules/dsh-stock-watch/__engine_test.mjs', parts.join('\n\n'));
console.log('harness written');
