'use strict';

/**
 * 抓取行情并归档（供 GitHub Actions 定时调用）
 *
 * 数据分三路，各自独立，任一失败不影响其余：
 *   brent    新浪财经日线（OIL）        → 首页 index.html 使用
 *   emBrent  东方财富 112.B00Y 当月连续 → 价差页 spread.html 使用
 *   gasoil   东方财富 112.G00Y ICE 低硫柴油 → 价差页 spread.html 使用
 *
 * 为什么首页坚持用新浪、价差页用东财：
 *   两家对“连续合约”的换月规则不同，2026-11-20 前后价差可达 2.6 美元。
 *   首页沿用使用者已习惯的新浪口径；价差页则让布伦特与柴油共用东财同一规则，
 *   保证两条线能用同一个交易日历逐日对齐，算出来的价差才自洽。
 *
 * 口径提示：ICE Low Sulphur Gasoil 与 EN590 同为 10ppm 超低硫柴油规格，交割地 ARA。
 * 新加坡 EN590 现货 = MOPS（Platts）± 升贴水，MOPS 为付费数据、无免费接口，
 * 通常与 ICE Gasoil 相差 5–20 美元/吨，故价差页给出的是可公开获取的柴油基准对照。
 *
 * 输出：
 *   data/store.json  全量归档（提交进仓库，作为唯一事实来源）
 *   docs/data.json   页面读取的数据（由 GitHub Pages 托管）
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_FILE = path.join(ROOT, 'data', 'store.json');
const PUBLIC_FILE = path.join(ROOT, 'docs', 'data.json');

const SECID_BRENT = '112.B00Y';
const SECID_GASOIL = '112.G00Y';
const BBL_PER_MT = 7.45;

const SINA_KLINE =
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=OIL';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

/**
 * 取文本。支持 http / https 双协议 —— 部分运行环境对 https 出站有限制，
 * 实测东财在个别沙箱里 https 不通、http 可通，所以保留降级能力。
 */
function fetchText(url, referer, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(
      url,
      {
        headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*' },
        timeout,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('行情接口返回 HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => req.destroy(new Error('行情接口请求超时')));
    req.on('error', reject);
  });
}

function nowInShanghai() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/* ------------------------------------------------------------------ */
/* 抓取                                                                */
/* ------------------------------------------------------------------ */

/** 新浪日线（JSONP）：date,open,high,low,close,volume */
async function fetchSinaBrent() {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const txt = await fetchText(SINA_KLINE, 'https://finance.sina.com.cn');
      const i = txt.indexOf('([');
      const j = txt.lastIndexOf(']');
      if (i < 0 || j < 0) throw new Error('新浪日线返回格式异常');
      const arr = JSON.parse(txt.slice(i + 1, j + 1));
      if (!Array.isArray(arr) || !arr.length) throw new Error('新浪日线数据为空');
      const out = arr
        .map((x) => ({
          date: x.date,
          open: parseFloat(x.open),
          high: parseFloat(x.high),
          low: parseFloat(x.low),
          close: parseFloat(x.close),
          volume: parseFloat(x.volume) || 0,
        }))
        .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && Number.isFinite(x.open) && x.open > 0)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      if (!out.length) throw new Error('新浪日线解析结果为空');
      return out;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(1500);
    }
  }
  throw lastErr;
}

/**
 * 东财日线。返回字段顺序为 date,open,close,high,low,volume。
 * 数据源有历史脏数据（2013 年 6–7 月柴油被放大 10 倍），
 * 用合理区间过滤掉，避免一条异常把整张图的纵轴撑坏。
 */
async function fetchKline(secid, minPrice, maxPrice) {
  const pathPart =
    `/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57` +
    `&klt=101&fqt=0&end=20500101&lmt=4000`;

  const inRange = (v) => Number.isFinite(v) && v >= minPrice && v <= maxPrice;

  let lastErr;
  for (const base of ['https://push2his.eastmoney.com', 'http://push2his.eastmoney.com']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const j = JSON.parse(await fetchText(base + pathPart, 'https://quote.eastmoney.com/'));
        const d = j && j.data;
        if (!d || !Array.isArray(d.klines) || !d.klines.length) throw new Error('日线数据为空');
        const out = [];
        let dropped = 0;
        for (const line of d.klines) {
          const f = line.split(',');
          if (f.length < 5) continue;
          const date = f[0];
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          const o = parseFloat(f[1]);
          if (!inRange(o)) {
            dropped++;
            continue;
          }
          const c = parseFloat(f[2]);
          const h = parseFloat(f[3]);
          const l = parseFloat(f[4]);
          out.push({
            date,
            open: o,
            high: inRange(h) ? h : o,
            low: inRange(l) ? l : o,
            close: inRange(c) ? c : o,
            volume: parseFloat(f[5]) || 0,
          });
        }
        if (!out.length) throw new Error('日线解析结果为空');
        if (dropped) console.log(`[kline] ${secid} 剔除异常点位 ${dropped} 条`);
        return out;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await sleep(800);
      }
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* 归档                                                                */
/* ------------------------------------------------------------------ */

function loadStore() {
  const empty = {
    brent: [],
    emBrent: [],
    gasoil: [],
    meta: { lastSync: null, lastError: null, brentCount: 0, gasoilCount: 0 },
  };
  try {
    if (!fs.existsSync(STORE_FILE)) return empty;
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      brent: Array.isArray(raw.brent) ? raw.brent.filter((r) => r && r.date) : [],
      emBrent: Array.isArray(raw.emBrent) ? raw.emBrent.filter((r) => r && r.date) : [],
      gasoil: Array.isArray(raw.gasoil) ? raw.gasoil.filter((r) => r && r.date) : [],
      meta: raw.meta || empty.meta,
    };
  } catch (err) {
    console.error('[store] 读取失败，按空库处理：', err.message);
    return empty;
  }
}

function mergeInto(list, rows) {
  if (!rows) return 0;
  const map = new Map(list.map((r) => [r.date, r]));
  let added = 0;
  for (const row of rows) {
    const old = map.get(row.date);
    if (!old) {
      list.push(row);
      added++;
    } else {
      // 开盘价一经记录不再改动；高/低/收/量随盘刷新
      old.high = row.high;
      old.low = row.low;
      old.close = row.close;
      old.volume = row.volume;
    }
  }
  return added;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  const store = loadStore();
  const stamp = nowInShanghai();

  // 只在数据真的变了才落盘，避免每半小时产生一个无意义提交
  const fingerprint = (s) => JSON.stringify({ b: s.brent, e: s.emBrent, g: s.gasoil });
  const before = fingerprint(store);

  const run = async (fn, label) => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      console.error(`[sync] ${label} 失败：${err.message}`);
      return { ok: false, error: err.message };
    }
  };

  // 串行抓取：并发请求容易触发对方风控
  const r1 = await run(fetchSinaBrent, '新浪布伦特');
  await sleep(500);
  const r2 = await run(() => fetchKline(SECID_BRENT, 10, 300), '东财布伦特');
  await sleep(500);
  const r3 = await run(() => fetchKline(SECID_GASOIL, 150, 3000), '东财柴油');

  const failed = [r1, r2, r3].filter((r) => !r.ok);

  if (failed.length === 3 && !store.brent.length) {
    console.error('::error::三路数据源全部失败，且本地无历史数据可保留');
    process.exit(1);
  }

  const a1 = mergeInto(store.brent, r1.ok ? r1.value : null);
  const a2 = mergeInto(store.emBrent, r2.ok ? r2.value : null);
  const a3 = mergeInto(store.gasoil, r3.ok ? r3.value : null);

  for (const k of ['brent', 'emBrent', 'gasoil']) {
    store[k].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  const changed = fingerprint(store) !== before;

  store.meta.brentCount = store.brent.length;
  store.meta.gasoilCount = store.gasoil.length;
  store.meta.lastError = failed.length ? failed.map((r) => r.error).join('；') : null;

  console.log(
    `[sync] 新浪布伦特 +${a1} / 东财布伦特 +${a2} / 柴油 +${a3}` +
      `　库存：${store.brent.length} ${store.emBrent.length} ${store.gasoil.length}`
  );

  if (failed.length) console.log(`::warning::部分数据源失败：${store.meta.lastError}`);

  // 首次运行时 docs/data.json 还不存在，即使数据没变化也必须生成一份，
  // 否则页面打开是空的
  const needInit = !fs.existsSync(PUBLIC_FILE);

  if (!changed && !needInit) {
    console.log('[store] 数据无变化，不写入、不提交');
    return;
  }

  store.meta.lastSync = stamp;
  writeJson(STORE_FILE, store);
  writeJson(PUBLIC_FILE, {
    ...store,
    bblPerMt: BBL_PER_MT,
    today: stamp,
  });

  const newest = store.brent[store.brent.length - 1];
  console.log(`[store] 已写入，最新交易日 ${newest ? newest.date : '—'}，同步于 ${stamp}`);
})().catch((err) => {
  console.error('::error::脚本异常：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
