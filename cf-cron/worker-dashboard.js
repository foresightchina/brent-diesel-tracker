/**
 * 布伦特行情台账 —— Cloudflare 定时闹钟（网页粘贴版）
 *
 * 作用只有一件：按 Cron 到点，去敲一下 GitHub Actions，让它跑抓取任务。
 * 自己不看行情——GitHub 已验证能访问行情接口，Cloudflare 未必能。
 *
 * 唯一要配的：环境变量 GH_TOKEN（GitHub 令牌，权限只需本仓库 Actions: Read and write）
 */

const REPO = 'foresightchina/brent-diesel-tracker';
const WORKFLOW = 'scrape.yml';
const REF = 'main';

export default {
  async scheduled(event, env, ctx) {
    const r = await trigger(env.GH_TOKEN);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  }
};

async function trigger(token) {
  if (!token) return { ok: false, error: '还没配置 GH_TOKEN' };

  // 上一次没跑完就别再排一个，免得堆队列
  const busy = await call(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=in_progress&per_page=1`,
    { headers: h(token) }
  );
  if (busy && busy.ok) {
    const j = await busy.json().catch(() => ({}));
    if (Array.isArray(j.workflow_runs) && j.workflow_runs.length) {
      return { ok: true, skipped: '上一次任务仍在运行' };
    }
  }

  const res = await call(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    { method: 'POST', headers: h(token), body: JSON.stringify({ ref: REF }) }
  );

  if (!res) return { ok: false, error: '网络请求失败' };
  if (res.status === 204) return { ok: true, triggered: true };

  const body = await res.text().catch(() => '');
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

function h(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'brent-diesel-cron',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

// 5xx 重试三次，4xx 直接返回（重试也没用）
async function call(url, init, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;
    } catch (e) {
      if (i === tries - 1) return null;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}
