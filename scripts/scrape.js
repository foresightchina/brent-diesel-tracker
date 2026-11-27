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

// 新浪外盘实时快照（有 Referer 防盗链，必须带来源页）
const SINA_RT = 'https://hq.sinajs.cn/list=hf_OIL';

// 最近一次成功取到的实时快照，供校正当日开盘价使用
let SINA_RT_SNAP = null;

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
        // Node 19 起默认 keepAlive=true，会复用空闲连接；东财/CDN 那边会主动关掉闲置 socket，
        // 复用到被关掉的那条就是 "socket hang up"（2026-11-27 14:21 那次抓取就是这么挂的）。
        // 这里每次都用新连接，代价是一次握手，换来不再撞这个坑。
        agent: false,
        headers: {
          'User-Agent': UA,
          Referer: referer,
          Accept: '*/*',
          'Cache-Control': 'no-cache',
        },
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

/** 新浪外盘实时快照：最新、最高、最低、昨结算、开盘
 *  字段顺序：0 最新 2 买 3 卖 4 最高 5 最低 6 时间 7 昨结算 8 开盘 12 日期 13 名称 */
async function fetchSinaRealtime() {
  const txt = await fetchText(SINA_RT, 'https://finance.sina.com.cn');
  const m = txt.match(/"([^"]*)"/);
  if (!m) throw new Error('新浪实时返回格式异常');
  const f = m[1].split(',');
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const date = (f[12] || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('新浪实时日期异常');
  return { date, open: num(f[8]), high: num(f[4]), low: num(f[5]), last: num(f[0]), prevSettle: num(f[7]) };
}

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

      // 日线接口对“当日尚未走完的那根 K 线”，开盘价偶尔会填成昨收
      // （2026-11-25 就是：日线给 88.35，而新浪自家实时接口开盘是 88.47）。
      // 用实时接口的“开盘”字段校正当日这一根，页面才与新浪行情页一致。
      try {
        const rt = await fetchSinaRealtime();
        SINA_RT_SNAP = rt;
        const last = out[out.length - 1];
        if (rt.date === last.date) {
          if (rt.open && Math.abs(rt.open - last.open) > 0.004) {
            console.log(`[sync] 当日开盘按实时校正：${last.open} → ${rt.open}`);
            last.open = rt.open;
          }
          if (rt.high) last.high = Math.max(last.high || 0, rt.high);
          if (rt.low) last.low = last.low ? Math.min(last.low, rt.low) : rt.low;
          if (rt.last) last.close = rt.last;
        }
      } catch (e) {
        console.log(`[sync] 新浪实时校正跳过：${e.message}`);
      }

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
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 带时间戳破缓存：CDN 上的旧副本会让当日那根 K 线迟迟不出现
        const url = base + pathPart + '&_=' + Date.now();
        const j = JSON.parse(await fetchText(url, 'https://quote.eastmoney.com/'));
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
        console.log(`[kline] ${secid} 第 ${attempt + 1} 次失败：${err.message || err.code || err}`);
        if (attempt < 2) await sleep(1200 * (attempt + 1));
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
  const fingerprint = (s) => JSON.stringify({ b: s.brent, e: s.emBrent, g: s.gasoil, l: s.meta.lastError });
  const before = fingerprint(store);

  const run = async (fn, label, key) => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      // 个别网络错误没有 message（只有 code），兜一下，免得台账里只剩一个空冒号
      const msg = (err && (err.message || err.code)) || String(err);
      console.error(`[sync] ${label} 失败：${msg}`);
      return { ok: false, error: msg, label, key };
    }
  };

  // 串行抓取：并发请求容易触发对方风控
  const r1 = await run(fetchSinaBrent, '新浪布伦特', 'brent');
  await sleep(500);
  const r2 = await run(() => fetchKline(SECID_BRENT, 10, 300), '东财布伦特', 'emBrent');
  await sleep(500);
  const r3 = await run(() => fetchKline(SECID_GASOIL, 150, 3000), '东财柴油', 'gasoil');

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

  // 「开盘价一经记录不再改动」是为了防止日间抖动反复改写，
  // 但当日那根 K 线万一在生成时被填错，就成了永远改不掉的错值
  // （2026-11-25：新浪日线把当日开盘填成昨收 88.35，实时是 88.47）。
  // 所以只对最新一天、且有更权威来源时，允许校正一次；隔日即冻结。
  const lb = store.brent[store.brent.length - 1];
  if (lb) {
    const prevBar = store.brent[store.brent.length - 2];
    const looksLikePrevClose =
      prevBar && Math.abs(lb.open - prevBar.close) < 0.005;   // 疑似“昨收占位”
    let better = null;
    let from = '';
    if (SINA_RT_SNAP && SINA_RT_SNAP.date === lb.date && SINA_RT_SNAP.open) {
      better = SINA_RT_SNAP.open;
      from = '新浪实时';
    } else {
      const le = store.emBrent[store.emBrent.length - 1];
      // 没有实时快照时，仅在“疑似占位”的情况下才用东财兜底，避免把两家切点差异搬进来
      if (looksLikePrevClose && le && le.date === lb.date && le.open > 0) {
        better = le.open;
        from = '东财日线';
      }
    }
    if (better && Math.abs(better - lb.open) > 0.004) {
      console.log(`[sync] 校正当日开盘（${from}）：${lb.open} → ${better}`);
      lb.open = better;
    }
  }

  const changed = fingerprint(store) !== before;

  store.meta.brentCount = store.brent.length;
  store.meta.gasoilCount = store.gasoil.length;

  // 只有“真的缺了最新一天”才算异常。行情源偶发抖动时重试一次就过得去，
  // 若把这类抖动也写进 lastError，页面会挂一行红字，而数据其实是齐的。
  const lastDateOf = (arr) => (arr && arr.length ? arr[arr.length - 1].date : '');
  const refDate = ['brent', 'emBrent', 'gasoil']
    .map((k) => lastDateOf(store[k]))
    .sort()
    .pop();
  const failedReal = failed.filter((f) => lastDateOf(store[f.key]) < refDate);

  store.meta.lastError = failedReal.length
    ? failedReal.map((r) => `${r.label}：${r.error}`).join('；')
    : null;

  console.log(
    `[sync] 新浪布伦特 +${a1} / 东财布伦特 +${a2} / 柴油 +${a3}` +
      `　库存：${store.brent.length} ${store.emBrent.length} ${store.gasoil.length}`
  );

  if (failedReal.length) console.log(`::warning::部分数据源未取到最新一天：${store.meta.lastError}`);
  else if (failed.length) console.log('[sync] 本次有个别源抖动，但最新一天的数据已在库，不记为异常');

  // 首次运行时 docs/data.json 还不存在，即使数据没变化也必须生成一份，
  // 否则页面打开是空的
  const needInit = !fs.existsSync(PUBLIC_FILE);

  /* 长期无人看管的看门狗 ------------------------------------------------
     最新交易日落后超过 5 个自然日（够覆盖周末和短假），说明抓取链路断了。
     这时仍然把已取到的数据写盘——不能因为报警就把数据一起丢掉——
     但让任务以失败退出。GitHub 会给仓库所有者发一封失败通知邮件，
     这是整条链路唯一的告警通道，也是"没人看着也能知道坏了"的唯一办法。 */
  const STALE_DAYS = 5;
  const checkStale = (stage) => {
    const lb = store.brent[store.brent.length - 1];
    if (!lb) {
      console.error(`::error::台账为空（${stage}），历史数据可能已丢失`);
      process.exitCode = 1;
      return;
    }
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const lag = Math.round((new Date(todayStr) - new Date(lb.date)) / 86400000);
    if (lag > STALE_DAYS) {
      console.error(`::error::最新交易日 ${lb.date} 落后 ${lag} 天（阈值 ${STALE_DAYS} 天），抓取链路可能已断（${stage}）`);
      process.exitCode = 1;
    }
  };

  if (!changed && !needInit) {
    console.log('[store] 数据无变化，不写入、不提交');
    checkStale('无变化');
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
  checkStale('已写入');
})().catch((err) => {
  console.error('::error::脚本异常：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
