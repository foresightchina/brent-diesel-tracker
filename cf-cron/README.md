# cf-cron —— 分钟级定时触发器

## 这是什么

一个小到几乎可以忽略的 Cloudflare Worker，只做一件事：

**按 5 分钟一次的节奏，去调用 GitHub 上的抓取工作流。**

它不抓数据、不存数据、不对外提供网页。抓取仍然跑在 GitHub 上（已验证能访问新浪和东财），页面仍然托管在 GitHub Pages。它只是替代了那个从未生效的 GitHub `schedule`。

## 为什么要绕这一道

GitHub Actions 自带的 `schedule` 官方定性是"尽力而为"：高峰期会延迟，甚至直接丢弃某次。本项目实测更糟——建仓当天 3 个应触发的时间点，一次都没跑。

Cloudflare 的 Cron Triggers 是分钟级、按点执行，免费账户每账户最多 5 个触发器、最小间隔 1 分钟，对这里绰绰有余。

而之所以不把抓取逻辑整个搬到 Worker 上，是因为 Cloudflare 的出口节点访问国内行情接口未必通；GitHub 那边已经实测能通三路数据源。所以分工是：**Cloudflare 管准时，GitHub 管干活。**

## 部署步骤

需要准备两样东西：一个 Cloudflare 账号（免费）、一个 GitHub 细粒度 Token。

### 一、创建 GitHub Token

打开 https://github.com/settings/personal-access-tokens/new

- **Token name**：`cf-cron-trigger`
- **Expiration**：建议 1 年（到期前 GitHub 会邮件提醒）
- **Repository access** → 选 **Only select repositories** → 只勾 `brent-diesel-tracker`
- **Permissions** → 展开 **Repository permissions** → 找到 **Actions** → 改为 **Read and write**
- 其余权限全部保持 No access
- 点 **Generate token**，复制那串 `github_pat_...`

这个 Token 只能触发这一个仓库的工作流，**不能读代码、不能改代码、不能碰别的仓库**。即使泄露，最坏结果是别人能让它多抓几次行情。

### 二、部署 Worker

在 PowerShell 里执行（把 `<粘贴你的Token>` 换成实际值，别带尖括号）：

```powershell
cd C:\Users\fores\WorkBuddy\2026-11-24-13-28-57\brent-diesel-github\cf-cron
npx wrangler login
```

`login` 会弹出浏览器，点 **Allow** 授权即可（只授权你自己的 Cloudflare 账号，不涉及 GitHub）。

登录成功后继续：

```powershell
npx wrangler secret put GH_TOKEN
```

它会提示 `Enter a secret value:`，把刚才那个 `github_pat_...` 粘进去回车。**输入时屏幕不显示字符，这是正常的。**

最后：

```powershell
npx wrangler deploy
```

看到 `Deployed` 和 `schedule: */5 * * * *` 就成功了。

## 验证是否真的在跑

部署后等 5–10 分钟，看两处：

1. **Cloudflare 侧**：`npx wrangler tail`，能看到每 5 分钟一条 `{"ok":true,"triggered":true}`
2. **GitHub 侧**：https://github.com/foresightchina/brent-diesel-tracker/actions
   运行记录里会出现 `event: workflow_dispatch` 的条目

如果 `wrangler tail` 里出现 `GH_TOKEN 权限不足`，回去检查第一步的 Actions 权限有没有设成 Read and write。

## 几个实现细节

- **防堆积**：触发前先查有没有正在跑的任务，有就跳过这一轮。否则 GitHub 的队列会越排越长。
- **4xx 不重试**：Token 错了、仓库名错了，重试一百次也没用，直接报错出来。
- **5xx 重试 3 次**：GitHub 偶尔 502，退避 0.8s / 1.6s 再试。
- **查不到运行状态时照常触发**：宁可多跑一次，不可漏掉。
- 这个 Worker 没有暴露任何对外网址，也不需要您访问它，所以 `workers.dev` 在国内被阻断**不影响**它工作。

## 想改频率

编辑 `wrangler.toml` 里的 `crons`，然后重新 `npx wrangler deploy`：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

`*/5` 可以改成 `*/2`、`*/1`（1 分钟是 Cloudflare 的下限），或改成只在交易时段跑：

```toml
crons = ["*/5 1-22 * * 1-5"]   # UTC 1-22 点（北京 9-6 点），周一到周五
```

## 关掉它

```powershell
npx wrangler delete
```

删掉后 GitHub 页面照常能看，只是数据不再自动更新。历史数据都在仓库里，不会丢。
