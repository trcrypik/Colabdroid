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
    if (now - job.started > 15 * 60 * 1000) {
      try { if (job.proc && !job.proc.killed) job.proc.kill('SIGKILL'); } catch (e) {}
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
  const { name, gpu, tpu, highMem } = req.body;
  const sessionName = name || 'colab-' + Math.random().toString(16).substring(2, 8);
  const args = ['new', '-s', sessionName];
  if (gpu && gpu !== 'NONE') args.push('--gpu', gpu);
  else if (tpu && tpu !== 'NONE') args.push('--tpu', tpu);
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
  const listPy =
    'import os,json,stat\\n' +
    'p=' + JSON.stringify(remotePath) + '\\n' +
    'out=[]\\n' +
    'try:\\n' +
    '  for n in sorted(os.listdir(p)):\\n' +
    '    fp=os.path.join(p,n)\\n' +
    '    try:\\n' +
    '      st=os.stat(fp); out.append({"name":n,"path":fp,"is_dir":stat.S_ISDIR(st.st_mode),"size":st.st_size,"mtime":int(st.st_mtime)})\\n' +
    '    except Exception as e:\\n' +
    '      out.append({"name":n,"path":fp,"error":str(e)})\\n' +
    '  print(json.dumps({"ok":True,"path":p,"entries":out}))\\n' +
    'except Exception as e:\\n' +
    '  print(json.dumps({"ok":False,"path":p,"error":str(e),"entries":[]}))\\n';
  const args = ['exec'];
  if (session) args.push('-s', session);
  const result = await runCommand('colab', args, listPy, 30000);
  const raw = (result.stdout || result.stderr || '').trim();
  // last JSON line
  let parsed = null;
  const lines = raw.split('\\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); break; } catch (e) {}
  }
  if (parsed) {
    return res.json({ success: !!parsed.ok, path: parsed.path || remotePath, entries: parsed.entries || [], error: parsed.error, raw });
  }
  // fallback plain ls
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
    if (job.session === session && job.status === 'waiting_auth') {
      try { job.proc.kill('SIGKILL'); } catch (e) {}
      driveMountJobs.delete(id);
    }
  }

  const args = ['drivemount'];
  args.push('-s', session);
  if (mountPath) args.push(mountPath);

  const jobId = 'dm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const proc = spawn('colab', args, {
    env: { ...process.env, PYTHONUNBUFFERED: '1', HOME: process.env.HOME }
  });

  const job = {
    id: jobId,
    session,
    mountPath,
    proc,
    stdout: '',
    stderr: '',
    authUrls: [],
    status: 'starting', // starting | waiting_auth | confirming | done | error
    started: Date.now(),
    exitCode: null,
    error: null
  };
  driveMountJobs.set(jobId, job);

  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  const onChunk = (s, which) => {
    if (which === 'out') job.stdout += s; else job.stderr += s;
    const m = s.match(urlRe);
    if (m) {
      for (const u of m) {
        if (!job.authUrls.includes(u) && /oauth|accounts\.google|authorize/i.test(u)) {
          job.authUrls.push(u);
        } else if (!job.authUrls.includes(u) && /http/i.test(u) && job.authUrls.length === 0) {
          job.authUrls.push(u);
        }
      }
      if (job.authUrls.length && job.status === 'starting') {
        job.status = 'waiting_auth';
      }
    }
    if (/Press Enter after/i.test(s) && job.status === 'starting') {
      job.status = 'waiting_auth';
    }
  };

  proc.stdout.on('data', (d) => onChunk(d.toString(), 'out'));
  proc.stderr.on('data', (d) => onChunk(d.toString(), 'err'));
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

  // Wait up to 120s for auth URL (Colab can be slow to print it)
  const waitUntil = Date.now() + 120000;
  while (Date.now() < waitUntil) {
    if (job.authUrls.length || job.status === 'waiting_auth') break;
    if (job.status === 'error' || job.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (job.exitCode !== null && !job.authUrls.length) {
    driveMountJobs.delete(jobId);
    return res.json({
      success: false,
      status: 'error',
      output: (job.stdout + '\n' + job.stderr).trim(),
      error: job.error || 'drivemount exited before auth URL appeared'
    });
  }

  res.json({
    success: true,
    jobId,
    status: job.status,
    authUrls: job.authUrls,
    mountPath,
    output: (job.stdout + '\n' + job.stderr).trim(),
    hint: '1) Open the auth URL and grant access. 2) Return here and press CONFIRM_MOUNT. Do not skip step 1.'
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
  // Send Enter only after user confirms browser auth
  try {
    if (job.proc.stdin && !job.proc.stdin.destroyed) {
      job.proc.stdin.write('\n');
      setTimeout(() => {
        try { job.proc.stdin.write('\n'); } catch (e) {}
      }, 500);
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }

  // Wait for process to finish (mount success or fail)
  const waitUntil = Date.now() + 120000;
  while (Date.now() < waitUntil) {
    if (job.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (job.exitCode === null) {
    return res.json({
      success: false,
      status: 'confirming',
      output: (job.stdout + '\n' + job.stderr).trim(),
      error: 'Still waiting for mount to finish — try CONFIRM again or check PTY'
    });
  }

  const ok = job.exitCode === 0;
  job.status = ok ? 'done' : 'error';
  const output = (job.stdout + '\n' + job.stderr).trim();
  // keep job briefly for status, then drop
  setTimeout(() => driveMountJobs.delete(jobId), 60000);

  res.json({
    success: ok,
    status: job.status,
    exitCode: job.exitCode,
    mountPath: job.mountPath,
    output,
    error: ok ? null : 'mount failed — authorize in browser first, then CONFIRM only once'
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

app.get('/api/notebooks'
, checkApiKey, async (req, res) => {
  const session = req.query.session;
  const root = req.query.path || '/content/drive/MyDrive/Colab Notebooks';
  const listPy =
    'import os,json\\n' +
    'root=' + JSON.stringify(root) + '\\n' +
    'found=[]\\n' +
    'def walk(d, depth=0):\\n' +
    '  if depth>3: return\\n' +
    '  try: names=sorted(os.listdir(d))\\n' +
    '  except Exception: return\\n' +
    '  for n in names:\\n' +
    '    fp=os.path.join(d,n)\\n' +
    '    if n.endswith(".ipynb") and os.path.isfile(fp):\\n' +
    '      try: found.append({"name":n,"path":fp,"size":os.path.getsize(fp)})\\n' +
    '      except Exception: found.append({"name":n,"path":fp})\\n' +
    '    elif os.path.isdir(fp) and not n.startswith("."):\\n' +
    '      walk(fp, depth+1)\\n' +
    'if not os.path.isdir(root):\\n' +
    '  print(json.dumps({"ok":False,"error":"path not found: "+root,"root":root,"notebooks":[]}))\\n' +
    'else:\\n' +
    '  walk(root)\\n' +
    '  print(json.dumps({"ok":True,"root":root,"notebooks":found,"count":len(found)}))\\n';
  const args = ['exec'];
  if (session) args.push('-s', session);
  const result = await runCommand('colab', args, listPy, 60000);
  const raw = (result.stdout || result.stderr || '').trim();
  let parsed = null;
  const lines = raw.split('\\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); break; } catch (e) {}
  }
  if (parsed) return res.json({ success: !!parsed.ok, ...parsed, raw });
  res.json({ success: false, notebooks: [], error: raw || 'parse failed', root });
});

app.post('/api/notebooks/run', checkApiKey, async (req, res) => {
  const { session, path: nbPath, timeout } = req.body || {};
  if (!nbPath) return res.status(400).json({ error: 'path required (.ipynb)' });
  if (!String(nbPath).endsWith('.ipynb')) {
    return res.status(400).json({ error: 'only .ipynb supported' });
  }
  const timeoutMs = (timeout || 600) * 1000;
  // Prefer colab exec -f; if CLI needs remote path only, exec runs it on VM
  const args = ['exec', '-f', nbPath];
  if (session) {
    // CLI: colab exec -s NAME -f file — file may need to exist locally OR on remote
    // Official CLI: -f reads local file. For remote notebook use python exec:
    args.length = 0;
    args.push('exec');
    args.push('-s', session);
  }
  let stdinCode = null;
  if (session) {
    // Execute notebook on VM via nbclient/jupyter if available, else run as JSON cells roughly via papermill-less approach
    stdinCode =
      'import json,sys,subprocess,os\\n' +
      'p=' + JSON.stringify(nbPath) + '\\n' +
      'print("Running notebook:", p)\\n' +
      'if not os.path.isfile(p):\\n' +
      '  raise SystemExit("Notebook not found: "+p)\\n' +
      '# Try jupyter/nbconvert execute\\n' +
      'cmds=[\\n' +
      '  ["jupyter","nbconvert","--to","notebook","--execute","--inplace",p],\\n' +
      '  ["python","-m","jupyter","nbconvert","--to","notebook","--execute","--inplace",p],\\n' +
      ']\\n' +
      'ok=False\\n' +
      'for c in cmds:\\n' +
      '  try:\\n' +
      '    r=subprocess.run(c,capture_output=True,text=True,timeout=' + str(int((timeout || 600))) + ')\\n' +
      '    print(r.stdout)\\n' +
      '    print(r.stderr)\\n' +
      '    if r.returncode==0:\\n' +
      '      ok=True; break\\n' +
      '  except Exception as e:\\n' +
      '    print("try failed", c, e)\\n' +
      'if not ok:\\n' +
      '  # Fallback: run code cells sequentially\\n' +
      '  nb=json.load(open(p))\\n' +
      '  g={}\\n' +
      '  for i,cell in enumerate(nb.get("cells",[])):\\n' +
      '    if cell.get("cell_type")!="code": continue\\n' +
      '    src="".join(cell.get("source") or [])\\n' +
      '    print(f"\\n# --- cell {i} ---")\\n' +
      '    try:\\n' +
      '      exec(compile(src, f"cell_{i}", "exec"), g, g)\\n' +
      '    except Exception as e:\\n' +
      '      print("CELL ERROR:", e)\\n' +
      '      raise\\n' +
      '  print("\\nNotebook finished (fallback cell exec)")\\n';
    const result = await runCommand('colab', args, stdinCode, timeoutMs);
    return res.json({
      success: result.success,
      path: nbPath,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      durationMs: result.durationMs
    });
  }
  // no session: try local -f
  const localArgs = ['exec', '-f', nbPath];
  const result = await runCommand('colab', localArgs, null, timeoutMs);
  res.json({
    success: result.success,
    path: nbPath,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: result.durationMs
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

  ws.on('close', () => {
    try { term.kill(); } catch (e) {}
  });

  ws.on('error', () => {
    try { term.kill(); } catch (e) {}
  });
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
