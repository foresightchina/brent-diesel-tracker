/**
 * 布伦特行情台账 —— Cloudflare 定时触发器（网页版，单文件）
 *
 * 这份是给 Cloudflare 网页控制台「直接粘贴」用的，不需要安装 Node、不需要 wrangler。
 * 功能与 src/index.js 完全一样，只是把仓库名写死，少配三个变量。
 *
 * 它自己不抓行情：Cloudflare 按 Cron 到点，它就去敲一下 GitHub 的 Actions，
 * 让 GitHub 那边的 scrape.yml 干活（已实测 GitHub 能访问行情接口，Cloudflare 不一定能）。
 *
 * 唯一需要配置的：环境变量 GH_TOKEN（GitHub 令牌，权限只需该仓库的 Actions: Read and write）。
 */

const GH_REPO = 'foresightchina/brent-diesel-tracker';
const GH_WORKFLOW = 'scrape.yml';
const GH_REF = 'main';
const API = 'https://api.github.com';

export default {
  // Cron 到点走这里
  async scheduled(event, env, ctx) {
    const r = await trigger(env, false);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  },

  // 用浏览器打开这个 Worker 的网址就会看到状态；POST 则立即跑一次
  async fetch(request, env) {
    try {
      if (request.method === 'POST') {
        const r = await trigger(env, true);
        return text(r, r.ok ? 200 : 502);
      }
      return text(await inspect(env), 200);
    } catch (err) {
      return text({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }
};

async function trigger(env, force) {
  const token = env.GH_TOKEN;
  if (!token) return { ok: false, error: '还没配置 GH_TOKEN' };

  if (!force) {
    const busy = await hasRunning(token);
    if (busy) return { ok: true, skipped: '上一次任务仍在运行' };
  }

  const res = await retry(
    `${API}/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ref: GH_REF })
    }
  );

  if (res.status === 204) return { ok: true, triggered: true };
  const body = await res.text();
  return {
    ok: false,
    status: res.status,
    error:
      res.status === 401 ? 'GH_TOKEN 无效或已过期'
      : res.status === 403 ? 'GH_TOKEN 权限不足，需要 Actions: Read and write'
      : res.status === 404 ? '仓库或工作流找不到'
      : body.slice(0, 200)
  };
}

async function hasRunning(token) {
  try {
    const res = await retry(
      `${API}/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/runs?status=in_progress&per_page=1`,
      { headers: headers(token) }
    );
    if (!res.ok) return false;
    const j = await res.json();
    return Array.isArray(j.workflow_runs) && j.workflow_runs.length > 0;
  } catch {
    return false;
  }
}

async function inspect(env) {
  const out = { ok: true, repo: GH_REPO, 有令牌: !!env.GH_TOKEN };
  try {
    const res = await retry(
      `${API}/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/runs?per_page=8`,
      { headers: headers(env.GH_TOKEN) }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    out.最近运行 = (j.workflow_runs || []).map((r) => ({
      触发方式: r.event,
      状态: r.status,
      结果: r.conclusion,
      时间: r.created_at
    }));
  } catch (err) {
    out.ok = false;
    out.error = String((err && err.message) || err);
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

async function retry(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res; // 4xx 重试没用
      last = new Error('HTTP ' + res.status);
    } catch (err) {
      last = err;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw last;
}

function text(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
