/**
 * 布伦特行情台账 —— 定时触发器
 *
 * 作用只有一件事：按分钟级精度去敲 GitHub，让它跑抓取任务。
 *
 * 为什么不把抓取逻辑搬到这里：
 *   GitHub Actions 的 schedule 属于“尽力而为”，实测在本仓库从未触发；
 *   而 Cloudflare 的 Cron 是分钟级、按点执行。但 Cloudflare 访问国内行情接口
 *   未必通，GitHub 已验证能通，所以分工是——Cloudflare 负责准时，GitHub 负责干活。
 *
 * 部署后由 wrangler.toml 里的 crons 触发，不需要对外暴露任何网址。
 */

const API = 'https://api.github.com';

export default {
  /** Cron 触发入口 */
  async scheduled(event, env, ctx) {
    const r = await trigger(env, 'cron');
    console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  },

  /** 手动触发 / 查看状态：GET 看状态，POST 立即跑一次 */
  async fetch(request, env) {
    try {
      if (request.method === 'POST') {
        const r = await trigger(env, 'manual', true);
        return json(r, r.ok ? 200 : 502);
      }
      const state = await inspect(env);
      return json(state, 200);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
  }
};

/** 触发一次抓取；force=true 时忽略“正在运行”的保护 */
async function trigger(env, source, force = false) {
  const repo = env.GH_REPO;
  const token = env.GH_TOKEN;
  const workflow = env.GH_WORKFLOW || 'scrape.yml';
  const ref = env.GH_REF || 'main';

  if (!repo || !token) {
    return { ok: false, error: '缺少 GH_REPO 或 GH_TOKEN，请用 wrangler secret put 配置' };
  }

  // 上一次还没跑完就别再排一个，否则 Requests 会堆在队列里
  if (!force) {
    const busy = await hasRunning(env);
    if (busy) return { ok: true, skipped: true, reason: '上一次任务仍在运行', source };
  }

  const res = await requestWithRetry(
    `${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ref })
    }
  );

  if (res.status === 204) return { ok: true, triggered: true, source };
  const text = await res.text();
  return {
    ok: false,
    status: res.status,
    error: res.status === 401 ? 'GH_TOKEN 无效或已过期'
      : res.status === 403 ? 'GH_TOKEN 权限不足（需要 Actions: write）'
      : res.status === 404 ? '仓库或工作流找不到（检查 GH_REPO 与文件名）'
      : text.slice(0, 200),
    source
  };
}

/** 是否有正在进行的运行 */
async function hasRunning(env) {
  try {
    const res = await requestWithRetry(
      `${API}/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW || 'scrape.yml'}/runs?status=in_progress&per_page=1`,
      { headers: headers(env.GH_TOKEN) }
    );
    if (!res.ok) return false;           // 查不到就照常触发，宁可多跑一次
    const j = await res.json();
    return Array.isArray(j.workflow_runs) && j.workflow_runs.length > 0;
  } catch {
    return false;
  }
}

/** 最近若干次运行，用于排查 */
async function inspect(env) {
  const out = { ok: true, repo: env.GH_REPO || null, hasToken: !!env.GH_TOKEN };
  try {
    const res = await requestWithRetry(
      `${API}/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW || 'scrape.yml'}/runs?per_page=8`,
      { headers: headers(env.GH_TOKEN) }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    out.recent = (j.workflow_runs || []).map(r => ({
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      at: r.created_at
    }));
  } catch (err) {
    out.ok = false;
    out.error = String(err && err.message || err);
  }
  return out;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'brent-diesel-cron',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function requestWithRetry(url, init, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;      // 4xx 不重试，重试也没用
      lastErr = new Error('HTTP ' + res.status);
    } catch (err) {
      lastErr = err;
    }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  throw lastErr;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
