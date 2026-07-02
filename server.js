const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const PORT        = process.env.PORT || 5500;
const ROOT        = __dirname;
const STREAM_URL  = process.env.STREAM_URL || 'http://rgkkw.live/live/1Aoen7elp5/IgMJ60tmAa/747283.ts';

// Timeout in ms for each upstream hop (30s to handle slow CDN nodes)
const HOP_TIMEOUT = 30000;
// Max retries on socket hang-up / timeout before giving up
const MAX_RETRIES  = 3;

const mime = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// ─── Proxy with redirect-following, retry, and generous timeout ───────────────

function proxyStream(targetUrl, res, hops, retriesLeft) {
  if (hops > 10) {
    if (!res.headersSent) { res.writeHead(502); res.end('Too many redirects'); }
    return;
  }

  const parsed  = new URL(targetUrl);
  const lib     = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    // Disguise as a real browser / media player
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept':          '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         `http://${parsed.hostname}/`,
      'Connection':      'keep-alive',
    },
  };

  console.log(`[hop ${hops}] Fetching: ${targetUrl}`);

  let timedOut = false;

  const req = lib.request(options, (streamRes) => {
    console.log(`Status: ${streamRes.statusCode}`);

    // Follow redirect
    if ([301, 302, 303, 307, 308].includes(streamRes.statusCode)) {
      const location = streamRes.headers['location'];
      console.log(`Redirecting to: ${location}`);
      streamRes.resume();
      const nextUrl = location.startsWith('http') ? location : new URL(location, targetUrl).href;
      proxyStream(nextUrl, res, hops + 1, MAX_RETRIES);
      return;
    }

    // Non-2xx from upstream — log and bail
    if (streamRes.statusCode < 200 || streamRes.statusCode >= 300) {
      console.error(`Upstream returned ${streamRes.statusCode}`);
      streamRes.resume();
      if (!res.headersSent) {
        res.writeHead(streamRes.statusCode);
        res.end(`Upstream error: ${streamRes.statusCode}`);
      }
      return;
    }

    // Stream the response
    res.writeHead(streamRes.statusCode, {
      'Content-Type':                streamRes.headers['content-type'] || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
      'Transfer-Encoding':           'chunked',
    });
    streamRes.pipe(res);

    streamRes.on('error', (e) => {
      console.error('Stream read error:', e.message);
    });
  });

  req.setTimeout(HOP_TIMEOUT, () => {
    timedOut = true;
    console.error(`Upstream timed out (hop ${hops}, retries left: ${retriesLeft})`);
    req.destroy();
    if (retriesLeft > 0) {
      console.log(`Retrying… (${retriesLeft} left)`);
      proxyStream(targetUrl, res, hops, retriesLeft - 1);
    } else if (!res.headersSent) {
      res.writeHead(504);
      res.end('Upstream timeout after retries');
    }
  });

  req.on('error', (e) => {
    if (timedOut) return; // already handled by setTimeout
    console.error('Request error:', e.message);
    if (retriesLeft > 0) {
      console.log(`Retrying after error… (${retriesLeft} left)`);
      proxyStream(targetUrl, res, hops, retriesLeft - 1);
    } else if (!res.headersSent) {
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    }
  });

  req.end();
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

http.createServer((req, res) => {
  const reqPath = new URL(req.url, 'http://localhost').pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Keep-alive ping endpoint (prevents Render free tier from sleeping)
  if (reqPath === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  // Proxy route — supports ?url= override for testing alternate stream URLs
  if (reqPath === '/stream') {
    const qs  = new URL(req.url, 'http://localhost').searchParams;
    const url = qs.get('url') || STREAM_URL;
    proxyStream(url, res, 1, MAX_RETRIES);
    return;
  }

  // Serve static files
  const filePath    = path.join(ROOT, reqPath === '/' ? 'player.html' : reqPath);
  const ext         = path.extname(filePath);
  const contentType = mime[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log('Server  → http://localhost:' + PORT);
  console.log('Stream  → http://localhost:' + PORT + '/stream');
});
