const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = 3303;
const SHEET_ID = '1H4RHKQPWvTPEfMLw6r9acN0z7FOT8TbfDJYFSjr0EVs';
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxbFD9NJZrDLImACAMiqMy_-1DMCPCPC4Zk4n-6U92QAoN2ej81YE-8rnR4eVGoHy9p0w/exec';

// ── Auth ─────────────────────────────────────────────────────────────────────

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

// ── Apps Script caller ────────────────────────────────────────────────────────

function callAppsScript(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    function doReq(targetUrl, hops) {
      if (hops > 5) return resolve(null);
      const parsed = url.parse(targetUrl);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.path,
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
      }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          return doReq(r.headers.location, hops + 1);
        }
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    }
    doReq(SCRIPT_URL, 0);
  });
}

// ── User management via Apps Script (with local fallback) ────────────────────

const localUsers = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
let usersCache = null;
let usersCacheTime = 0;
const USERS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getUsers() {
  if (usersCache && Date.now() - usersCacheTime < USERS_CACHE_TTL) return usersCache;
  const result = await callAppsScript({ type: 'get_users' });
  if (result && result.status === 'ok' && result.users && result.users.length > 0) {
    usersCache = result.users;
    usersCacheTime = Date.now();
    return usersCache;
  }
  return localUsers; // fallback
}

function invalidateUsersCache() {
  usersCache = null;
  usersCacheTime = 0;
}

// ── Static files ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

function isPublicPath(pathname) {
  if (pathname === '/login' || pathname === '/logout') return true;
  if (pathname === '/login.html') return true;
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
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*' }
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        doRequest(r.headers.location, redirectCount + 1); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      r.pipe(res);
    });
    req.on('error', (e) => { res.writeHead(500); res.end('Error: ' + e.message); });
    req.end();
  }
  doRequest(sheetUrl, 0);
}

// ── Apps Script proxy (for frontend calls) ────────────────────────────────────

function proxyAppsScript(body, res) {
  function doReq(targetUrl, hops) {
    if (hops > 5) { res.writeHead(500); res.end(JSON.stringify({ status: 'error', msg: 'Too many redirects' })); return; }
    const parsed = url.parse(targetUrl);
    let data = '';
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return doReq(r.headers.location, hops + 1);
      }
      r.on('data', d => data += d);
      r.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    req.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ status: 'error', msg: e.message })); });
    req.write(body);
    req.end();
  }
  doReq(SCRIPT_URL, 0);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── POST /login ─────────────────────────────────────────────────────────
  if (pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let creds;
      try { creds = JSON.parse(body); } catch (e) { creds = {}; }
      const { username, password } = creds;
      const allUsers = await getUsers();
      const user = allUsers.find(u => u.username === username && u.password === password);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid username or password' }));
        return;
      }
      const token = generateToken();
      sessions[token] = { username: user.username, role: user.role, displayName: user.displayName, expires: Date.now() + 28800000 };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800` });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // ── GET /logout ──────────────────────────────────────────────────────────
  if (pathname === '/logout') {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/session=([a-f0-9]+)/);
    if (match && sessions[match[1]]) delete sessions[match[1]];
    res.writeHead(302, { 'Location': '/login', 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' });
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
    if (!session) { res.writeHead(302, { 'Location': '/login' }); res.end(); return; }
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
    const allUsers = await getUsers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allUsers.map(u => ({ username: u.username, role: u.role, displayName: u.displayName }))));
    return;
  }

  // ── POST /api/users ───────────────────────────────────────────────────────
  if (pathname === '/api/users' && req.method === 'POST') {
    const session = getSession(req);
    if (!session) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (session.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Invalid JSON' })); return; }
      const { username, password, role, displayName } = data;
      if (!username) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Username is required' })); return; }
      if (!password || password.length < 4) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Password must be at least 4 characters' })); return; }
      const result = await callAppsScript({ type: 'add_user', username, password, role: role || 'staff', displayName: displayName || username });
      console.log('[add_user] result:', JSON.stringify(result));
      if (!result || result.status !== 'ok') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: result ? result.msg : 'Failed to add user' }));
        return;
      }
      invalidateUsersCache();
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
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Invalid JSON' })); return; }
      if (data.role && data.role !== session.role && targetUsername === session.username) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Cannot change your own role' })); return;
      }
      const payload = { type: 'edit_user', username: targetUsername };
      if (data.displayName !== undefined) payload.displayName = data.displayName;
      if (data.password && data.password.length >= 4) payload.password = data.password;
      if (data.role !== undefined && targetUsername !== session.username) payload.role = data.role;
      const result = await callAppsScript(payload);
      if (!result || result.status !== 'ok') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: result ? result.msg : 'Failed to update user' }));
        return;
      }
      invalidateUsersCache();
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
    const allUsers = await getUsers();
    const targetUser = allUsers.find(u => u.username === targetUsername);
    if (!targetUser) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'User not found' })); return; }
    const adminCount = allUsers.filter(u => u.role === 'admin').length;
    if (targetUser.role === 'admin' && adminCount <= 1) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'Cannot delete the last admin' })); return; }
    const result = await callAppsScript({ type: 'delete_user', username: targetUsername });
    if (!result || result.status !== 'ok') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: result ? result.msg : 'Failed to delete user' }));
      return;
    }
    invalidateUsersCache();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ── DEBUG: test Apps Script connection ───────────────────────────────────
  if (pathname === '/api/debug-users' && req.method === 'GET') {
    const result = await callAppsScript({ type: 'get_users' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result, cache: usersCache, fallback: localUsers }));
    return;
  }

  // ── Proxy Apps Script POST (frontend) ─────────────────────────────────────
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
