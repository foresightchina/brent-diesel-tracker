'use strict';

/**
 * 本地预览用的极简静态服务器。
 *
 * 为什么需要它：页面用 fetch('./data.json') 读数据，
 * 直接双击 index.html（file:// 协议）会被浏览器的同源策略拦住。
 * 用本文件起一个本地服务就能正常看：node scripts/serve.js
 *
 * 线上由 GitHub Pages 托管，不需要这个文件。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8123;
const ROOT = path.join(__dirname, '..', 'docs');

// 自 2026-11-27：这个服务有过一次被忘在后台跑了两小时的记录，白白占着端口和内存。
// 现在空闲 20 分钟自动退出——预览本来就是一时的，忘了关就让它自己关。
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 20);
let lastHit = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    lastHit = Date.now();
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    if (rel === '/spread') rel = '/spread.html';

    const full = path.join(ROOT, rel);
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`本地预览：http://127.0.0.1:${PORT}/`);
    console.log(`价差页面：http://127.0.0.1:${PORT}/spread`);
    console.log(`空闲 ${IDLE_MINUTES} 分钟无访问将自动退出（Ctrl+C 可立即停止）`);
  });

// 每两分钟看一眼：很久没人访问就自己退，避免忘了关一直挂着
setInterval(() => {
  const idleMin = (Date.now() - lastHit) / 60000;
  if (idleMin >= IDLE_MINUTES) {
    console.log(`已空闲 ${Math.round(idleMin)} 分钟，自动退出。`);
    process.exit(0);
  }
}, 120000).unref?.();

process.on('SIGINT', () => {
  console.log('\n预览服务已停止。');
  process.exit(0);
});
