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
  });
