const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const PORT        = process.env.PORT || 5500;
const ROOT        = __dirname;
const STREAM_URL  = 'http://rgkkw.live/live/1Aoen7elp5/IgMJ60tmAa/747283.ts';

const mime = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// Follow redirects and pipe final response to client
function proxyStream(targetUrl, res, hops) {
  if (hops > 10) {
    res.writeHead(502);
    res.end('Too many redirects');
    return;
  }

  const parsed  = new URL(targetUrl);
  const lib     = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':     '*/*',
      'Connection': 'keep-alive',
    }
  };

  console.log(`[hop ${hops}] Fetching: ${targetUrl}`);

  const req = lib.request(options, (streamRes) => {
    console.log(`Status: ${streamRes.statusCode}`);

    // Follow redirect
    if ([301, 302, 303, 307, 308].includes(streamRes.statusCode)) {
      const location = streamRes.headers['location'];
      console.log(`Redirecting to: ${location}`);
      streamRes.resume();
      const nextUrl = location.startsWith('http') ? location : new URL(location, targetUrl).href;
      proxyStream(nextUrl, res, hops + 1);
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
  });

  // Fail fast if upstream is unreachable
  req.setTimeout(10000, () => {
    console.error('Upstream timed out');
    req.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end('Upstream timeout');
    }
  });

  req.on('error', (e) => {
    console.error('Request error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    }
  });

  req.end();
}

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

  // Proxy route
  if (reqPath === '/stream') {
    proxyStream(STREAM_URL, res, 1);
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
