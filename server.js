const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const url = require('url');

let pty = null;
try {
  pty = require('node-pty');
  console.log('[COLAB-BACKEND] node-pty loaded — real PTY available');
} catch (e) {
  console.warn('[COLAB-BACKEND] node-pty not available, /pty will fail until rebuilt:', e.message);
}

const app = express();
const server = http.createServer(app);

// Two logical WS endpoints on one HTTP server via noServer + upgrade routing
const wssExec = new WebSocket.Server({ noServer: true });
const wssPty = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 8080;
const REQUIRE_API_KEY = process.env.REQUIRE_API_KEY !== '0';
const API_KEY = process.env.API_KEY || '';
// Browser UI gate: https://your-app.northflank.app/?token=WEB_TOKEN
const WEB_TOKEN = (process.env.WEB_TOKEN || '').trim();
if (REQUIRE_API_KEY && !API_KEY) {
  console.error('[COLAB-BACKEND] FATAL: API_KEY is required. Set env API_KEY or REQUIRE_API_KEY=0 for local dev.');
  process.exit(1);
}

if (process.env.COLAB_HOME) {
  process.env.HOME = process.env.COLAB_HOME;
}
const CONFIG_DIR = path.join(os.homedir(), '.config', 'colab-cli');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const HELPER_SCRIPT = path.join(__dirname, 'colab_auth_helper.py');
try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (e) {}

if (process.env.COLAB_AUTH_TOKEN && !fs.existsSync(TOKEN_FILE)) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    let tokenData = process.env.COLAB_AUTH_TOKEN.trim();
    if (tokenData.startsWith('{')) {
      fs.writeFileSync(TOKEN_FILE, tokenData, 'utf8');
    } else {
      fs.writeFileSync(TOKEN_FILE, Buffer.from(tokenData, 'base64').toString('utf8'), 'utf8');
    }
    console.log('[COLAB-BACKEND] Seeded token.json from COLAB_AUTH_TOKEN env variable');
  } catch (err) {
    console.error('[COLAB-BACKEND] Failed to parse COLAB_AUTH_TOKEN env:', err.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ dest: '/tmp/colab_uploads/' });

// In-flight interactive Drive mounts (waiting for browser OAuth + user confirm)
const driveMountJobs = new Map();
function pruneDriveJobs() {
  const now = Date.now();
  for (const [id, job] of driveMountJobs.entries()) {
    if (now - job.started > 20 * 60 * 1000) {
      try { if (job.kill) job.kill(); else if (job.proc && !job.proc.killed) job.proc.kill('SIGKILL'); } catch (e) {}
      driveMountJobs.delete(id);
    }
  }
}
setInterval(pruneDriveJobs, 60000);


function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let ok = 0;
  for (let i = 0; i < a.length; i++) ok |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return ok === 0;
}

/** Gate HTML/static UI when WEB_TOKEN is set. Open: https://host/?token=WEB_TOKEN */
function gateWebUi(req, res, next) {
  if (!WEB_TOKEN) return next();

  // Always public (Northflank health checks)
  if (req.path === '/health') return next();

  // REST + uploads use API_KEY, not WEB_TOKEN
  if (req.path.startsWith('/api')) return next();

  const qToken = typeof req.query.token === 'string' ? req.query.token : '';
  const cookies = parseCookies(req);
  const cToken = cookies.web_token || '';

  if (qToken && safeEqual(qToken, WEB_TOKEN)) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      'web_token=' + encodeURIComponent(WEB_TOKEN) +
        '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' +
        (secure ? '; Secure' : '')
    );
    // Drop token from URL after setting cookie (cleaner + less leakage via Referer)
    if (req.path === '/' || req.path === '') {
      return res.redirect(302, '/');
    }
    return next();
  }

  if (cToken && safeEqual(cToken, WEB_TOKEN)) {
    return next();
  }

  res.status(401).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unauthorized</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#07090e;color:#00ff66;font-family:ui-monospace,monospace;padding:24px;text-align:center}
  code{color:#00f0ff}
  p{color:#8892b0;max-width:420px;line-height:1.5}
</style></head>
<body><div>
  <h1 style="letter-spacing:1px">401 // ACCESS DENIED</h1>
  <p>Open with your secret link:<br>
  <code>https://&lt;host&gt;/?token=WEB_TOKEN</code></p>
  <p style="font-size:12px">Set <code>WEB_TOKEN</code> in Northflank environment variables.</p>
</div></body></html>`);
}

app.use(gateWebUi);
app.use(express.static(path.join(__dirname, 'public')));

const checkApiKey = (req, res, next) => {
  if (!API_KEY) return next();
  const clientKey =
    req.headers['x-api-key'] ||
    req.query.api_key ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (clientKey && clientKey === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key (header x-api-key)' });
};

function checkWsApiKey(reqUrl) {
  if (!API_KEY) return true;
  try {
    const q = url.parse(reqUrl, true).query || {};
    return q.api_key === API_KEY;
  } catch (e) {
    return false;
  }
}

function runCommand(cmd, args = [], stdinData = null, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const proc = spawn(cmd, args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1', HOME: process.env.HOME }
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs);
    if (stdinData !== null) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startTime
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        code: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        timedOut,
        durationMs: Date.now() - startTime
      });
    });
  });
}

// --- REST ---

app.get('/health', async (req, res) => {
  const versionRes = await runCommand('colab', ['version'], null, 5000);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    colabCli: versionRes.stdout.trim() || versionRes.stderr.trim() || 'unknown',
    colabCliOk: versionRes.success,
    nodeVersion: process.version,
    platform: process.platform,
    apiKeyRequired: Boolean(API_KEY),
    configDir: CONFIG_DIR,
    ptyAvailable: Boolean(pty),
    webTokenRequired: Boolean(WEB_TOKEN),
    endpoints: {
      lineExecWs: '/terminal?session=NAME&api_key=KEY',
      realPtyWs: '/pty?session=NAME&api_key=KEY&cols=80&rows=24',
      webUi: WEB_TOKEN ? '/?token=WEB_TOKEN' : '/'
    },
    mode: pty
      ? 'PTY (colab console) + line-exec fallback'
      : 'line-exec only (node-pty missing)'
  });
});

app.get('/api/status', checkApiKey, async (req, res) => {
  const authRes = await runCommand('python3', [HELPER_SCRIPT, 'status'], null, 5000);
  let authData = { authenticated: false };
  try { authData = JSON.parse(authRes.stdout.trim()); } catch (e) {
    authData = { error: authRes.stderr || 'Status parse error', authenticated: false };
  }
  let sessions = [];
  if (fs.existsSync(SESSIONS_FILE)) {
    try { sessions = Object.values(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))); } catch (e) {}
  }
  res.json({
    auth: authData,
    sessionsCount: sessions.length,
    sessions,
    serverUptime: process.uptime(),
    memory: process.memoryUsage(),
    ptyAvailable: Boolean(pty)
  });
});

app.get('/api/auth/status', checkApiKey, async (req, res) => {
  const result = await runCommand('python3', [HELPER_SCRIPT, 'status'], null, 8000);
  try { res.json(JSON.parse(result.stdout.trim())); }
  catch (e) { res.status(500).json({ error: 'Failed to inspect auth status', details: result.stderr }); }
});

app.get('/api/auth/login-url', checkApiKey, async (req, res) => {
  const result = await runCommand('python3', [HELPER_SCRIPT, 'generate-url'], null, 10000);
  try { res.json(JSON.parse(result.stdout.trim())); }
  catch (e) { res.status(500).json({ error: 'Failed to generate OAuth URL', details: result.stderr }); }
});

app.post('/api/auth/code', checkApiKey, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Authorization code is required' });
  const result = await runCommand('python3', [HELPER_SCRIPT, 'exchange-code', code.trim()], null, 15000);
  try { res.json(JSON.parse(result.stdout.trim())); }
  catch (e) { res.status(500).json({ error: 'Failed to exchange code', details: result.stderr }); }
});

app.post('/api/auth/token', checkApiKey, async (req, res) => {
  const tokenData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const result = await runCommand('python3', [HELPER_SCRIPT, 'save-token'], tokenData, 5000);
  try { res.json(JSON.parse(result.stdout.trim())); }
  catch (e) { res.status(500).json({ error: 'Failed to save token', details: result.stderr }); }
});

app.delete('/api/auth', checkApiKey, (req, res) => {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    res.json({ success: true, message: 'Google Colab credentials removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', checkApiKey, async (req, res) => {
  let localSessions = {};
  if (fs.existsSync(SESSIONS_FILE)) {
    try { localSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) {}
  }
  const cliRes = await runCommand('colab', ['sessions'], null, 12000);
  res.json({
    sessions: Object.values(localSessions),
    cliOutput: cliRes.stdout || cliRes.stderr,
    success: cliRes.success
  });
});

app.post('/api/sessions', checkApiKey, async (req, res) => {
  let { name, gpu, tpu, highMem, accelerator } = req.body;
  // UI may send accelerator like "TPU:v5e1" or "GPU:T4"
  if (accelerator && typeof accelerator === 'string') {
    const a = accelerator.trim();
    if (/^TPU:/i.test(a)) { tpu = a.split(':')[1]; gpu = null; }
    else if (/^GPU:/i.test(a)) { gpu = a.split(':')[1]; tpu = null; }
    else if (a === 'NONE' || a === 'CPU') { gpu = null; tpu = null; }
  }
  const sessionName = name || 'colab-' + Math.random().toString(16).substring(2, 8);
  const args = ['new', '-s', sessionName];
  if (tpu && tpu !== 'NONE') args.push('--tpu', String(tpu).toLowerCase());
  else if (gpu && gpu !== 'NONE') args.push('--gpu', gpu);
  if (highMem) args.push('--high-mem');
  console.log(`[COLAB-BACKEND] Provisioning: colab ${args.join(' ')}`);
  const result = await runCommand('colab', args, null, 120000);
  res.json({
    sessionName,
    success: result.success,
    output: result.stdout || result.stderr,
    error: !result.success ? result.stderr : null,
    durationMs: result.durationMs
  });
});

app.get('/api/sessions/:name', checkApiKey, async (req, res) => {
  const sessionName = req.params.name;
  const result = await runCommand('colab', ['status', '-s', sessionName], null, 10000);
  res.json({ sessionName, output: result.stdout || result.stderr, success: result.success });
});

app.delete('/api/sessions/:name', checkApiKey, async (req, res) => {
  const sessionName = req.params.name;
  const result = await runCommand('colab', ['stop', '-s', sessionName], null, 30000);
  res.json({ sessionName, success: result.success, output: result.stdout || result.stderr });
});

/** Stop every session known to the CLI (account-wide on this token). */
app.delete('/api/sessions', checkApiKey, async (req, res) => {
  const cliRes = await runCommand('colab', ['sessions'], null, 20000);
  const text = (cliRes.stdout || '') + '\n' + (cliRes.stderr || '');
  const names = new Set();

  // Parse common CLI table / list formats
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || /^name\b/i.test(t) || /^session/i.test(t) || /^---/.test(t)) continue;
    // first token often session name
    const m = t.match(/^([A-Za-z0-9_.-]+)\b/);
    if (m) {
      const n = m[1];
      if (!/^(cpu|gpu|tpu|idle|busy|active|status|running|true|false)$/i.test(n)) {
        names.add(n);
      }
    }
  }

  // Also local cache
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const local = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const v of Object.values(local)) {
        if (v && v.name) names.add(v.name);
        if (typeof v === 'string') names.add(v);
      }
      for (const k of Object.keys(local)) names.add(k);
    } catch (e) {}
  }

  const results = [];
  for (const name of names) {
    const r = await runCommand('colab', ['stop', '-s', name], null, 45000);
    results.push({
      sessionName: name,
      success: r.success,
      output: (r.stdout || r.stderr || '').slice(0, 500)
    });
  }

  // Final sweep: sometimes CLI accepts stop without -s for default
  const again = await runCommand('colab', ['sessions'], null, 15000);

  res.json({
    success: results.every((x) => x.success) || results.length > 0,
    stopped: results.filter((x) => x.success).map((x) => x.sessionName),
    failed: results.filter((x) => !x.success),
    results,
    sessionsAfter: again.stdout || again.stderr,
    parsedNames: [...names]
  });
});

app.post('/api/sessions/:name/restart', checkApiKey, async (req, res) => {
  const sessionName = req.params.name;
  const result = await runCommand('colab', ['restart-kernel', '-s', sessionName], null, 20000);
  res.json({ sessionName, success: result.success, output: result.stdout || result.stderr });
});

app.get('/api/sessions/:name/url', checkApiKey, async (req, res) => {
  const sessionName = req.params.name;
  const result = await runCommand('colab', ['url', '-s', sessionName], null, 10000);
  res.json({ sessionName, url: (result.stdout || '').trim(), success: result.success });
});

app.post('/api/exec', checkApiKey, async (req, res) => {
  let { session, code, isBash, timeout } = req.body;
  if (!code) return res.status(400).json({ error: 'Code or command is required' });
  let execCode = code;
  if (isBash) {
    execCode = code.includes('\n') ? '%%bash\n' + code : (code.startsWith('!') ? code : '!' + code);
  }
  const timeoutMs = (timeout || 60) * 1000;
  const args = ['exec'];
  if (session) args.push('-s', session);
  const result = await runCommand('colab', args, execCode, timeoutMs);
  res.json({
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    exitCode: result.code,
    durationMs: result.durationMs
  });
});

app.post('/api/exec/stream', checkApiKey, (req, res) => {
  let { session, code, isBash } = req.body;
  if (!code) return res.status(400).json({ error: 'Code or command is required' });
  let execCode = code;
  if (isBash) {
    execCode = code.includes('\n') ? '%%bash\n' + code : (code.startsWith('!') ? code : '!' + code);
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const args = ['exec'];
  if (session) args.push('-s', session);
  const proc = spawn('colab', args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  proc.stdin.write(execCode);
  proc.stdin.end();
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  proc.stdout.on('data', (d) => sendEvent('stdout', d.toString()));
  proc.stderr.on('data', (d) => sendEvent('stderr', d.toString()));
  proc.on('close', (code) => { sendEvent('close', { exitCode: code }); res.end(); });
  proc.on('error', (err) => { sendEvent('error', { error: err.message }); res.end(); });
  req.on('close', () => { try { proc.kill('SIGTERM'); } catch (e) {} });
});

app.get('/api/gpu', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const args = ['exec'];
  if (session) args.push('-s', session);
  const queryCmd = '!nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu,utilization.memory --format=csv,noheader,nounits';
  const result = await runCommand('colab', args, queryCmd, 15000);
  if (!result.success || !result.stdout) {
    return res.json({ hasGpu: false, raw: result.stdout || result.stderr, message: 'No GPU detected or command failed' });
  }
  try {
    const lines = result.stdout.trim().split('\n').filter((l) => l.trim().length > 0);
    const gpus = lines.map((line) => {
      const parts = line.split(',').map((p) => p.trim());
      return {
        name: parts[0],
        driverVersion: parts[1],
        memoryTotalMb: parseFloat(parts[2]),
        memoryUsedMb: parseFloat(parts[3]),
        memoryFreeMb: parseFloat(parts[4]),
        temperatureC: parseFloat(parts[5]),
        gpuUtilizationPercent: parseFloat(parts[6]),
        memoryUtilizationPercent: parseFloat(parts[7])
      };
    });
    res.json({ hasGpu: gpus.length > 0, gpus, raw: result.stdout });
  } catch (err) {
    res.json({ hasGpu: true, raw: result.stdout, parseError: err.message });
  }
});

app.get('/api/system', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const args = ['exec'];
  if (session) args.push('-s', session);
  const cmd = '!echo "=== CPU ==="; lscpu | head -20; echo; echo "=== MEM ==="; free -h; echo; echo "=== DISK ==="; df -h /content 2>/dev/null || df -h /';
  const result = await runCommand('colab', args, cmd, 20000);
  res.json({ success: result.success, output: result.stdout || result.stderr });
});

app.get('/api/usage', checkApiKey, async (req, res) => {
  const result = await runCommand('colab', ['usage'], null, 15000);
  res.json({ success: result.success, output: result.stdout || result.stderr });
});

app.get('/api/files', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const remotePath = req.query.path || '/content';
  const listPy = [
    'import os, json, stat',
    'p = ' + JSON.stringify(remotePath),
    'out = []',
    'try:',
    '    for n in sorted(os.listdir(p)):',
    '        fp = os.path.join(p, n)',
    '        try:',
    '            st = os.stat(fp)',
    '            out.append({"name": n, "path": fp, "is_dir": stat.S_ISDIR(st.st_mode), "size": st.st_size, "mtime": int(st.st_mtime)})',
    '        except Exception as e:',
    '            out.append({"name": n, "path": fp, "error": str(e)})',
    '    print(json.dumps({"ok": True, "path": p, "entries": out}))',
    'except Exception as e:',
    '    print(json.dumps({"ok": False, "path": p, "error": str(e), "entries": []}))',
  ].join('\n');
  const args = ['exec'];
  if (session) args.push('-s', session);
  const result = await runCommand('colab', args, listPy, 30000);
  const raw = (result.stdout || result.stderr || '').trim();
  let parsed = null;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); break; } catch (e) {}
  }
  if (parsed) {
    return res.json({ success: !!parsed.ok, path: parsed.path || remotePath, entries: parsed.entries || [], error: parsed.error, raw });
  }
  const lsArgs = ['ls'];
  if (session) lsArgs.push('-s', session);
  lsArgs.push(remotePath);
  const ls = await runCommand('colab', lsArgs, null, 15000);
  res.json({ success: ls.success, path: remotePath, entries: [], output: ls.stdout || ls.stderr, raw });
});

app.get('/api/files/download', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: 'path required' });
  if (remotePath.includes('..')) return res.status(400).json({ error: 'invalid path' });
  const localTmp = path.join('/tmp', 'colab_dl_' + Date.now() + '_' + path.basename(remotePath).replace(/[^a-zA-Z0-9._-]/g, '_'));
  const args = ['download'];
  if (session) args.push('-s', session);
  args.push(remotePath, localTmp);
  const result = await runCommand('colab', args, null, 300000);
  if (!result.success || !fs.existsSync(localTmp)) {
    return res.status(500).json({ error: result.stderr || result.stdout || 'download failed' });
  }
  res.download(localTmp, path.basename(remotePath), () => {
    try { fs.unlinkSync(localTmp); } catch (e) {}
  });
});

app.post('/api/files/upload', checkApiKey, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const session = req.body.session;
  let destDir = (req.body.path || '/content').replace(/\/$/, '');
  if (destDir.includes('..')) return res.status(400).json({ error: 'invalid path' });
  const remotePath = destDir + '/' + req.file.originalname;
  const args = ['upload'];
  if (session) args.push('-s', session);
  args.push(req.file.path, remotePath);
  const result = await runCommand('colab', args, null, 300000);
  try { fs.unlinkSync(req.file.path); } catch (e) {}
  res.json({ success: result.success, remotePath, output: result.stdout || result.stderr });
});


/** Extract usable Google Drive OAuth URLs from CLI text (skip truncated "..."). */
function extractDriveAuthUrls(text) {
  if (!text) return [];
  const joined = String(text)
    .replace(/\r/g, '')
    .replace(/(https?:\/\/[^\n]+)\n([^\s\n][^\n]*)/g, '$1$2');

  const found = [];
  const re = /https?:\/\/[^\s"'<>\])]+/g;
  let m;
  while ((m = re.exec(joined)) !== null) {
    let u = m[0];
    u = u.replace(/[.,;:]+$/, '');
    u = u.replace(/&amp;/g, '&');
    if (!u || u.includes('...')) continue;
    if (u.length < 48) continue;
    found.push(u);
  }

  const score = (u) => {
    let s = 0;
    if (/accounts\.google\.com/i.test(u)) s += 50;
    if (/oauth|authorize/i.test(u)) s += 30;
    if (/authorize-for-drive|drive\.google|auth\/drive/i.test(u)) s += 20;
    if (/colab\.research\.google\.com/i.test(u) && !/oauth|authorize/i.test(u)) s -= 40;
    if (u.length > 120) s += 10;
    return s;
  };

  const uniq = [...new Set(found)];
  uniq.sort((a, b) => score(b) - score(a));
  return uniq.filter((u) => score(u) >= 30);
}

// --- Google Drive mount (2-step: start → user auth in browser → confirm) ---
// Colab drive.mount is inherently interactive; there is no fully browserless
// consumer-account path. We never auto-send Enter before the user confirms.

app.post('/api/drivemount/start', checkApiKey, async (req, res) => {
  const session = req.body.session;
  const mountPath = req.body.path || '/content/drive';
  if (!session) return res.status(400).json({ error: 'session required' });

  pruneDriveJobs();
  // kill previous job for same session
  for (const [id, job] of driveMountJobs.entries()) {
    if (job.session === session && (job.status === 'waiting_auth' || job.status === 'starting' || job.status === 'confirming')) {
      try { if (job.kill) job.kill(); else if (job.proc) job.proc.kill('SIGKILL'); } catch (e) {}
      driveMountJobs.delete(id);
    }
  }

  // Patch kernel default timeout to 10 minutes, then run interactive drivemount.
  // Default drive.mount timeout is 120s — too short for mobile browser OAuth.
  const patchPy =
    'import google.colab.drive as _drv\n' +
    '_orig = _drv.mount\n' +
    'def _mount(mountpoint, force_remount=False, timeout_ms=600000, readonly=False):\n' +
    '  print("[colab-backend] mount timeout_ms", timeout_ms, flush=True)\n' +
    '  return _orig(mountpoint, force_remount=force_remount, timeout_ms=timeout_ms, readonly=readonly)\n' +
    '_drv.mount = _mount\n' +
    'print("[colab-backend] drive.mount patched timeout_ms=600000", flush=True)\n';
  try {
    await runCommand('colab', ['exec', '-s', session], patchPy, 60000);
  } catch (e) {
    console.warn('[drivemount] patch failed', e.message);
  }

  const args = ['drivemount', '-s', session];
  if (mountPath) args.push(mountPath);

  const jobId = 'dm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // Prefer node-pty so "Press Enter" sees a real TTY
  let usePty = Boolean(pty);
  let proc = null;
  let term = null;
  if (usePty) {
    term = pty.spawn('colab', args, {
      name: 'xterm-256color',
      cols: 200,
      rows: 40,
      cwd: process.env.HOME || os.homedir(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        TERM: 'xterm-256color',
        HOME: process.env.HOME || os.homedir()
      }
    });
  } else {
    proc = spawn('colab', args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1', HOME: process.env.HOME }
    });
  }

  const job = {
    id: jobId,
    session,
    mountPath,
    proc,
    term,
    usePty,
    stdout: '',
    stderr: '',
    authUrls: [],
    status: 'starting',
    started: Date.now(),
    exitCode: null,
    error: null,
    writeStdin(data) {
      try {
        if (job.usePty && job.term) job.term.write(data);
        else if (job.proc && job.proc.stdin && !job.proc.stdin.destroyed) job.proc.stdin.write(data);
      } catch (e) {}
    },
    kill() {
      try {
        if (job.usePty && job.term) job.term.kill();
        else if (job.proc) job.proc.kill('SIGKILL');
      } catch (e) {}
    }
  };
  driveMountJobs.set(jobId, job);

  const refreshAuthUrls = () => {
    const all = extractDriveAuthUrls(job.stdout + '\n' + job.stderr);
    if (all.length) {
      job.authUrls = all;
      if (job.status === 'starting') job.status = 'waiting_auth';
    }
  };

  const onChunk = (s) => {
    job.stdout += s;
    refreshAuthUrls();
  };

  if (usePty) {
    term.onData((d) => onChunk(d));
    term.onExit(({ exitCode }) => {
      job.exitCode = exitCode;
      if (job.status !== 'done') {
        job.status = exitCode === 0 ? 'done' : 'error';
        if (exitCode !== 0) job.error = 'process exited with code ' + exitCode;
      }
    });
  } else {
    proc.stdout.on('data', (d) => onChunk(d.toString()));
    proc.stderr.on('data', (d) => onChunk(d.toString()));
    proc.on('close', (code) => {
      job.exitCode = code;
      if (job.status !== 'done') {
        job.status = code === 0 ? 'done' : 'error';
        if (code !== 0) job.error = 'process exited with code ' + code;
      }
    });
    proc.on('error', (err) => {
      job.status = 'error';
      job.error = err.message;
    });
  }

  // Wait up to 150s for a *full* OAuth URL (ignore truncated "..." log lines)
  const waitUntil = Date.now() + 150000;
  while (Date.now() < waitUntil) {
    refreshAuthUrls();
    if (job.authUrls.length > 0) break;
    if (job.status === 'error' || job.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  refreshAuthUrls();

  if (job.exitCode !== null && !job.authUrls.length) {
    driveMountJobs.delete(jobId);
    return res.json({
      success: false,
      status: 'error',
      output: (job.stdout + '\n' + job.stderr).trim(),
      error: job.error || 'drivemount exited before a full auth URL appeared'
    });
  }

  res.json({
    success: true,
    jobId,
    status: job.authUrls.length ? 'waiting_auth' : job.status,
    authUrls: job.authUrls,
    mountPath,
    output: (job.stdout + '\n' + job.stderr).trim(),
    hint: job.authUrls.length
      ? '1) Open the FULL accounts.google.com link. 2) Allow. 3) CONFIRM_MOUNT.'
      : 'Full OAuth URL not seen yet — wait and retry START, or check status. Ignore truncated colab.research.google.com... lines.'
  });
});

app.post('/api/drivemount/confirm', checkApiKey, async (req, res) => {
  const { jobId } = req.body || {};
  const job = driveMountJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'job not found or expired — call /api/drivemount/start again' });
  if (job.status === 'done') {
    return res.json({
      success: job.exitCode === 0,
      status: 'done',
      output: (job.stdout + '\n' + job.stderr).trim(),
      exitCode: job.exitCode
    });
  }
  if (job.status === 'error') {
    return res.json({
      success: false,
      status: 'error',
      error: job.error,
      output: (job.stdout + '\n' + job.stderr).trim()
    });
  }

  job.status = 'confirming';
  // Send Enter only after user confirms browser auth (drive.mount input())
  const pokeEnter = () => {
    try {
      if (job.writeStdin) job.writeStdin('\r');
      if (job.writeStdin) job.writeStdin('\n');
      else if (job.proc && job.proc.stdin && !job.proc.stdin.destroyed) job.proc.stdin.write('\n');
    } catch (e) {}
  };
  try {
    pokeEnter();
    setTimeout(pokeEnter, 300);
    setTimeout(pokeEnter, 1500);
    setTimeout(pokeEnter, 4000);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }

  // Wait up to 3 min for mount to finish after Enter
  const waitUntil = Date.now() + 180000;
  while (Date.now() < waitUntil) {
    if (job.exitCode !== null) break;
    if (/MOUNT_OK|Mounted at/i.test(job.stdout + job.stderr)) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  // If still running but MOUNT_OK seen, success
  const output = (job.stdout + '\n' + job.stderr).trim();
  const mounted = /MOUNT_OK|Mounted at|\/content\/drive/i.test(output) && !/ValueError.*mount failed/i.test(output);

  if (job.exitCode === null && !mounted) {
    return res.json({
      success: false,
      status: 'confirming',
      jobId,
      output,
      error: 'Still waiting — finish browser Allow, then CONFIRM again. Job kept alive.'
    });
  }

  const ok = job.exitCode === 0 || mounted;
  if (job.exitCode !== null) {
    job.status = ok ? 'done' : 'error';
    setTimeout(() => driveMountJobs.delete(jobId), 120000);
  }

  res.json({
    success: ok,
    status: job.status,
    jobId,
    exitCode: job.exitCode,
    mountPath: job.mountPath,
    output,
    error: ok ? null : 'mount failed — complete Google Allow (wait for "you may close this"), return quickly, CONFIRM within 10 min of START'
  });
});

app.get('/api/drivemount/status', checkApiKey, (req, res) => {
  const job = driveMountJobs.get(req.query.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    jobId: job.id,
    status: job.status,
    authUrls: job.authUrls,
    exitCode: job.exitCode,
    output: (job.stdout + '\n' + job.stderr).trim().slice(-4000),
    error: job.error
  });
});

// Legacy single-call endpoint → redirect clients to 2-step
app.post('/api/drivemount', checkApiKey, async (req, res) => {
  res.status(400).json({
    success: false,
    error: 'Use 2-step flow: POST /api/drivemount/start then POST /api/drivemount/confirm after browser auth',
    endpoints: ['/api/drivemount/start', '/api/drivemount/confirm', '/api/drivemount/status']
  });
});


app.get('/api/notebooks', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const root = req.query.path || '/content/drive/MyDrive/Colab Notebooks';
  const listPy = [
    'import os, json',
    'root = ' + JSON.stringify(root),
    'found = []',
    'def walk(d, depth=0):',
    '    if depth > 3:',
    '        return',
    '    try:',
    '        names = sorted(os.listdir(d))',
    '    except Exception:',
    '        return',
    '    for n in names:',
    '        fp = os.path.join(d, n)',
    '        try:',
    '            if n.endswith(".ipynb") and os.path.isfile(fp):',
    '                try:',
    '                    found.append({"name": n, "path": fp, "size": os.path.getsize(fp)})',
    '                except Exception:',
    '                    found.append({"name": n, "path": fp})',
    '            elif os.path.isdir(fp) and not n.startswith("."):',
    '                walk(fp, depth + 1)',
    '        except Exception:',
    '            pass',
    'if not os.path.isdir(root):',
    '    print(json.dumps({"ok": False, "error": "path not found: " + root, "root": root, "notebooks": []}))',
    'else:',
    '    walk(root)',
    '    print(json.dumps({"ok": True, "root": root, "notebooks": found, "count": len(found)}))',
  ].join('\n');

  const args = ['exec'];
  if (session) args.push('-s', session);
  const result = await runCommand('colab', args, listPy, 90000);
  const raw = (result.stdout || result.stderr || '').trim();
  let parsed = null;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); break; } catch (e) {}
  }
  if (parsed) return res.json({ success: !!parsed.ok, ...parsed, raw });
  res.json({
    success: false,
    notebooks: [],
    error: raw || 'parse failed',
    root,
    hint: result.success ? undefined : 'exec failed — is Drive mounted and session alive?'
  });
});

app.post('/api/notebooks/run', checkApiKey, async (req, res) => {
  const { session, path: nbPath, timeout } = req.body || {};
  if (!nbPath) return res.status(400).json({ error: 'path required (.ipynb)' });
  if (!String(nbPath).endsWith('.ipynb')) {
    return res.status(400).json({ error: 'only .ipynb supported' });
  }
  const timeoutMs = (timeout || 600) * 1000;
  const args = ['exec'];
  if (session) args.push('-s', session);

  const stdinCode = [
    'import json, subprocess, os, sys',
    'p = ' + JSON.stringify(nbPath),
    'print("Running notebook:", p, flush=True)',
    'if not os.path.isfile(p):',
    '    raise SystemExit("Notebook not found: " + p)',
    'ok = False',
    'for c in [',
    '    ["jupyter", "nbconvert", "--to", "notebook", "--execute", "--inplace", p],',
    '    ["python", "-m", "jupyter", "nbconvert", "--to", "notebook", "--execute", "--inplace", p],',
    ']:',
    '    try:',
    '        r = subprocess.run(c, capture_output=True, text=True, timeout=' + String(Math.max(60, parseInt(timeout, 10) || 600)) + ')',
    '        print(r.stdout or "", end="")',
    '        print(r.stderr or "", end="")',
    '        if r.returncode == 0:',
    '            ok = True',
    '            break',
    '    except Exception as e:',
    '        print("try failed", c, e, flush=True)',
    'if not ok:',
    '    nb = json.load(open(p))',
    '    g = {}',
    '    for i, cell in enumerate(nb.get("cells", [])):',
    '        if cell.get("cell_type") != "code":',
    '            continue',
    '        src = "".join(cell.get("source") or [])',
    '        print("\\n# --- cell %d ---" % i, flush=True)',
    '        try:',
    '            exec(compile(src, "cell_%d" % i, "exec"), g, g)',
    '        except Exception as e:',
    '            print("CELL ERROR:", e, flush=True)',
    '            raise',
    '    print("\\nNotebook finished (fallback cell exec)", flush=True)',
    'else:',
    '    print("Notebook finished (nbconvert)", flush=True)',
  ].join('\n');

  const result = await runCommand('colab', args, stdinCode, timeoutMs);
  res.json({
    success: result.success,
    path: nbPath,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  });
});


app.get('/api/notebooks/open-url', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const nbPath = req.query.path;
  if (!session) return res.status(400).json({ error: 'session required' });

  // Session Colab UI URL
  const urlRes = await runCommand('colab', ['url', '-s', session], null, 15000);
  const sessionUrl = (urlRes.stdout || '').trim().split('\n').map(s => s.trim()).find(s => /^https?:\/\//i.test(s)) || (urlRes.stdout || '').trim();

  let driveFileId = null;
  let notebookUrl = null;
  if (nbPath) {
    const idPy = [
      'import os, subprocess, json',
      'p = ' + JSON.stringify(nbPath),
      'fid = None',
      'try:',
      '    fid = subprocess.check_output(["xattr", "-p", "user.drive.id", p], text=True, stderr=subprocess.DEVNULL).strip()',
      'except Exception:',
      '    try:',
      '        # FUSE sometimes stores id in extended attrs differently',
      '        out = subprocess.check_output(["getfattr", "-n", "user.drive.id", "--only-values", p], text=True, stderr=subprocess.DEVNULL).strip()',
      '        fid = out or None',
      '    except Exception:',
      '        fid = None',
      'print(json.dumps({"path": p, "exists": os.path.isfile(p), "driveFileId": fid}))',
    ].join('\n');
    const idRes = await runCommand('colab', ['exec', '-s', session], idPy, 30000);
    const raw = (idRes.stdout || '').trim();
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j.driveFileId) {
          driveFileId = j.driveFileId;
          notebookUrl = 'https://colab.research.google.com/drive/' + j.driveFileId;
        }
        break;
      } catch (e) {}
    }
  }

  res.json({
    success: Boolean(sessionUrl || notebookUrl),
    sessionUrl: sessionUrl || null,
    notebookUrl,
    driveFileId,
    hint: notebookUrl
      ? 'Open notebookUrl for full interactive UI (widgets, buttons, inputs).'
      : 'Open sessionUrl, then open your .ipynb from the left file browser / Drive.'
  });
});

app.post('/api/install', checkApiKey, async (req, res) => {
  const { session, packages } = req.body;
  if (!packages) return res.status(400).json({ error: 'packages list is required' });
  const pkgList = Array.isArray(packages) ? packages : String(packages).trim().split(/\s+/);
  const args = ['install'];
  if (session) args.push('-s', session);
  args.push(...pkgList);
  const result = await runCommand('colab', args, null, 300000);
  res.json({ success: result.success, output: result.stdout || result.stderr, durationMs: result.durationMs });
});

// --- WebSocket upgrade router ---

server.on('upgrade', (request, socket, head) => {
  const { pathname } = url.parse(request.url);
  if (pathname === '/terminal') {
    wssExec.handleUpgrade(request, socket, head, (ws) => {
      wssExec.emit('connection', ws, request);
    });
  } else if (pathname === '/pty') {
    wssPty.handleUpgrade(request, socket, head, (ws) => {
      wssPty.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Line-exec WS (legacy / fallback)
wssExec.on('connection', (ws, req) => {
  if (!checkWsApiKey(req.url)) {
    ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized: Invalid API Key\r\n' }));
    return ws.close();
  }
  const q = url.parse(req.url, true).query || {};
  const session = q.session || '';
  let activeChild = null;

  ws.send(JSON.stringify({
    type: 'banner',
    data:
      '\x1b[33m[LINE-EXEC MODE]\x1b[0m each line runs as separate colab exec.\r\n' +
      '\x1b[90mFor a real shell use the PTY tab / WS /pty\x1b[0m\r\n' +
      `\x1b[36mSession: ${session || 'DEFAULT'}\x1b[0m\r\n\r\n`
  }));

  ws.on('message', (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());
      if (msg.type === 'exec') {
        const cmd = msg.command || '';
        const isBash = msg.isBash !== false;
        const targetSession = msg.session || session;
        if (cmd === 'clear') return ws.send(JSON.stringify({ type: 'clear' }));
        let execCode = cmd;
        if (isBash) {
          execCode = cmd.includes('\n') ? '%%bash\n' + cmd : (cmd.startsWith('!') ? cmd : '!' + cmd);
        }
        const args = ['exec'];
        if (targetSession) args.push('-s', targetSession);
        ws.send(JSON.stringify({ type: 'exec_start', command: cmd, session: targetSession }));
        activeChild = spawn('colab', args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
        activeChild.stdin.write(execCode);
        activeChild.stdin.end();
        activeChild.stdout.on('data', (data) => ws.send(JSON.stringify({ type: 'stdout', data: data.toString() })));
        activeChild.stderr.on('data', (data) => ws.send(JSON.stringify({ type: 'stderr', data: data.toString() })));
        activeChild.on('close', (exitCode) => {
          activeChild = null;
          ws.send(JSON.stringify({
            type: 'exec_end',
            exitCode,
            data: `\r\n\x1b[90m[exit ${exitCode}]\x1b[0m\r\n`
          }));
        });
        activeChild.on('error', (err) => {
          activeChild = null;
          ws.send(JSON.stringify({ type: 'error', data: err.message + '\r\n' }));
        });
      } else if (msg.type === 'cancel' || msg.type === 'sigint') {
        if (activeChild) {
          activeChild.kill('SIGINT');
          ws.send(JSON.stringify({ type: 'stdout', data: '^C\r\n' }));
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', data: e.message + '\r\n' }));
    }
  });

  ws.on('close', () => {
    if (activeChild) {
      try { activeChild.kill('SIGTERM'); } catch (e) {}
      activeChild = null;
    }
  });
});

// Real PTY WS — colab console inside node-pty
wssPty.on('connection', (ws, req) => {
  if (!checkWsApiKey(req.url)) {
    ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized API key' }));
    return ws.close();
  }
  if (!pty) {
    ws.send(JSON.stringify({
      type: 'error',
      data: 'node-pty is not installed on this server. Rebuild Docker image with node-pty.'
    }));
    return ws.close();
  }

  const q = url.parse(req.url, true).query || {};
  const session = (q.session || '').trim();
  let cols = Math.max(20, parseInt(q.cols, 10) || 80);
  let rows = Math.max(5, parseInt(q.rows, 10) || 24);
  // mode: console (default) | ssh
  const mode = (q.mode || 'console').toLowerCase();

  const args = mode === 'ssh' ? ['ssh'] : ['console'];
  if (session) args.push('-s', session);

  console.log(`[PTY] spawn colab ${args.join(' ')} cols=${cols} rows=${rows}`);

  let term;
  try {
    term = pty.spawn('colab', args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PYTHONUNBUFFERED: '1',
        HOME: process.env.HOME || os.homedir()
      }
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', data: 'Failed to spawn PTY: ' + err.message }));
    return ws.close();
  }

  ws.send(JSON.stringify({
    type: 'ready',
    data: {
      session: session || null,
      mode,
      cols,
      rows,
      pid: term.pid
    }
  }));

  // Keep WebSocket alive through proxies (Northflank / mobile) during long idle (gemini-cli thinking)
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (e) {}
    }
  }, 15000);

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      // binary-ish text stream for xterm
      try {
        ws.send(JSON.stringify({ type: 'stdout', data }));
      } catch (e) {}
    }
  });

  term.onExit(({ exitCode, signal }) => {
    console.log(`[PTY] exit code=${exitCode} signal=${signal}`);
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      } catch (e) {}
      try { ws.close(); } catch (e) {}
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      // raw text → stdin
      try { term.write(raw.toString()); } catch (err) {}
      return;
    }
    if (msg.type === 'stdin' && typeof msg.data === 'string') {
      try { term.write(msg.data); } catch (e) {}
    } else if (msg.type === 'resize') {
      const c = parseInt(msg.cols, 10);
      const r = parseInt(msg.rows, 10);
      if (c > 0 && r > 0) {
        cols = c;
        rows = r;
        try { term.resize(cols, rows); } catch (e) {}
      }
    } else if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
    }
  });

  const cleanup = () => {
    clearInterval(keepAlive);
    try { term.kill(); } catch (e) {}
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('======================================================');
  console.log('  COLAB CLI BACKEND');
  console.log('  Port:              ' + PORT);
  console.log('  API key required:  ' + Boolean(API_KEY));
  console.log('  Config dir:        ' + CONFIG_DIR);
  console.log('  node-pty:          ' + (pty ? 'YES' : 'NO'));
  console.log('  WEB_TOKEN gate:    ' + (WEB_TOKEN ? 'ON (open /?token=...)' : 'OFF'));
  console.log('  Line-exec WS:      /terminal?session=&api_key=');
  console.log('  Real PTY WS:       /pty?session=&api_key=&cols=&rows=');
  console.log('======================================================');
  console.log('');
});
