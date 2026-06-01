const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = 3303;
const SHEET_ID = '1H4RHKQPWvTPEfMLw6r9acN0z7FOT8TbfDJYFSjr0EVs';

// ── Auth ────────────────────────────────────────────────────────────────────

// Simple in-memory sessions: { token: { username, role, displayName, expires } }
const sessions = {};

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([a-f0-9]+)/);
  if (!match) return null;
  const session = sessions[match[1]];
  if (!session) return null;
  if (Date.now() > session.expires) { delete sessions[match[1]]; return null; }
  return session;
}

// Load users from users.json
let users = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));

function saveUsers() {
  fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(users, null, 2), 'utf8');
}

// ── Static files ─────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

// Paths that do not require authentication
function isPublicPath(pathname) {
  if (pathname === '/login' || pathname === '/logout') return true;
  if (pathname === '/login.html') return true;
  // Static assets
  const ext = path.extname(pathname);
  if (['.svg', '.png', '.ico', '.css', '.js'].includes(ext)) return true;
  return false;
}

// ── Google Sheets proxy ───────────────────────────────────────────────────────

function fetchGoogleSheets(gid, res) {
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;

  function doRequest(targetUrl, redirectCount) {
    if (redirectCount > 5) { res.writeHead(500); res.end('Too many redirects'); return; }
    const parsed = url.parse(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      }
    };
    const req = https.request(options, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        doRequest(r.headers.location, redirectCount + 1);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      r.pipe(res);
    });
    req.on('error', (e) => { res.writeHead(500); res.end('Error: ' + e.message); });
    req.end();
  }

  doRequest(sheetUrl, 0);
}

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxbFD9NJZrDLImACAMiqMy_-1DMCPCPC4Zk4n-6U92QAoN2ej81YE-8rnR4eVGoHy9p0w/exec';

function proxyAppsScript(body, res) {
  const parsed = url.parse(SCRIPT_URL);
  let data = '';
  const req2 = https.request({
    hostname: parsed.hostname,
    path: parsed.path,
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
  }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      const redir = url.parse(r.headers.location);
      let d2 = '';
      const req3 = https.request({ hostname: redir.hostname, path: redir.path, method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }
      }, (r2) => {
        r2.on('data', d => d2 += d);
        r2.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(d2); });
      });
      req3.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ status:'error', msg: e.message })); });
      req3.write(body); req3.end(); return;
    }
    r.on('data', d => data += d);
    r.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });
  req2.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ status:'error', msg: e.message })); });
  req2.write(body);
  req2.end();
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── POST /login ──────────────────────────────────────────────────────────
  if (pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let creds;
      try { creds = JSON.parse(body); } catch (e) { creds = {}; }
      const { username, password } = creds;
      const user = users.find(u => u.username === username && u.password === password);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid username or password' }));
        return;
      }
      const token = generateToken();
      sessions[token] = {
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        expires: Date.now() + 28800000, // 8 hours
      };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
      });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // ── GET /logout ──────────────────────────────────────────────────────────
  if (pathname === '/logout') {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/session=([a-f0-9]+)/);
    if (match && sessions[match[1]]) delete sessions[match[1]];
    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0',
    });
    res.end();
    return;
  }

  // ── GET /login ───────────────────────────────────────────────────────────
  if (pathname === '/login') {
    const filePath = path.join(__dirname, 'login.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── Auth middleware ───────────────────────────────────────────────────────
  if (!isPublicPath(pathname)) {
    const session = getSession(req);
    if (!session) {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
      return;
    }
  }

  // ── GET /api/me ──────────────────────────────────────────────────────────
  if (pathname === '/api/me' && req.method === 'GET') {
    const session = getSession(req);
    if (!session) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ username: session.username, role: session.role, displayName: session.displayName }));
    return;
  }

  // ── GET /api/users ────────────────────────────────────────────────────────
  if (pathname === '/api/users' && req.method === 'GET') {
    const session = getSession(req);
    if (!session) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (session.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(users.map(u => ({ username: u.username, role: u.role, displayName: u.displayName }))));
    return;
  }

  // ── POST /api/users ───────────────────────────────────────────────────────
  if (pathname === '/api/users' && req.method === 'POST') {
    const session = getSession(req);
    if (!session) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (session.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Invalid JSON' })); return; }
      const { username, password, role, displayName } = data;
      if (!username) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Username is required' })); return; }
      if (!password || password.length < 4) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Password must be at least 4 characters' })); return; }
      if (users.find(u => u.username === username)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Username already exists' })); return; }
      users.push({ username, password, role: role || 'staff', displayName: displayName || username });
      saveUsers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // ── PUT /api/users/:username ──────────────────────────────────────────────
  if (pathname.startsWith('/api/users/') && req.method === 'PUT') {
    const session = getSession(req);
    if (!session) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (session.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const targetUsername = decodeURIComponent(pathname.slice('/api/users/'.length));
    const user = users.find(u => u.username === targetUsername);
    if (!user) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'User not found' })); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Invalid JSON' })); return; }
      if (data.role && data.role !== user.role && targetUsername === session.username) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Cannot change your own role' })); return;
      }
      if (data.displayName !== undefined) user.displayName = data.displayName;
      if (data.role !== undefined && targetUsername !== session.username) user.role = data.role;
      if (data.password && data.password.length >= 4) user.password = data.password;
      saveUsers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // ── DELETE /api/users/:username ───────────────────────────────────────────
  if (pathname.startsWith('/api/users/') && req.method === 'DELETE') {
    const session = getSession(req);
    if (!session) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (session.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const targetUsername = decodeURIComponent(pathname.slice('/api/users/'.length));
    if (targetUsername === session.username) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Cannot delete yourself' })); return; }
    const adminCount = users.filter(u => u.role === 'admin').length;
    const targetUser = users.find(u => u.username === targetUsername);
    if (!targetUser) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'User not found' })); return; }
    if (targetUser.role === 'admin' && adminCount <= 1) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Cannot delete the last admin' })); return; }
    users = users.filter(u => u.username !== targetUsername);
    saveUsers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ── Proxy Apps Script POST ────────────────────────────────────────────────
  if (pathname === '/api/script' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => proxyAppsScript(body, res));
    return;
  }

  // ── Proxy Google Sheets ───────────────────────────────────────────────────
  if (pathname === '/api/sheet') {
    const gid = parsed.query.gid;
    if (!gid) { res.writeHead(400); res.end('Missing gid'); return; }
    fetchGoogleSheets(gid, res);
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('\x1b[32m%s\x1b[0m', '\n  ✅ The Coral Staff Management');
  console.log('\n  - Local:   \x1b[36mhttp://localhost:' + PORT + '\x1b[0m\n');
});
