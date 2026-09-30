const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/terminal' });

const PORT = process.env.PORT || 8080;
// Production default: API key required. Set REQUIRE_API_KEY=0 only for local debug.
const REQUIRE_API_KEY = process.env.REQUIRE_API_KEY !== '0';
const API_KEY = process.env.API_KEY || '';
if (REQUIRE_API_KEY && !API_KEY) {
  console.error('[COLAB-BACKEND] FATAL: API_KEY is required. Set env API_KEY or REQUIRE_API_KEY=0 for local dev.');
  process.exit(1);
}

// Persist colab-cli state on volume (Northflank: mount at /data, set HOME=/data COLAB_HOME=/data)
if (process.env.COLAB_HOME) {
  process.env.HOME = process.env.COLAB_HOME;
}
const CONFIG_DIR = path.join(os.homedir(), '.config', 'colab-cli');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const HELPER_SCRIPT = path.join(__dirname, 'colab_auth_helper.py');
try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (e) {}

// Auto-seed token from environment variable if provided
if (process.env.COLAB_AUTH_TOKEN && !fs.existsSync(TOKEN_FILE)) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    let tokenData = process.env.COLAB_AUTH_TOKEN.trim();
    if (tokenData.startsWith('{')) {
      fs.writeFileSync(TOKEN_FILE, tokenData, 'utf8');
    } else {
      const decoded = Buffer.from(tokenData, 'base64').toString('utf8');
      fs.writeFileSync(TOKEN_FILE, decoded, 'utf8');
    }
    console.log('[COLAB-BACKEND] Seeded token.json from COLAB_AUTH_TOKEN env variable');
  } catch (err) {
    console.error('[COLAB-BACKEND] Failed to parse COLAB_AUTH_TOKEN env:', err.message);
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads
const upload = multer({ dest: '/tmp/colab_uploads/' });

// Auth check middleware — when API_KEY is set, all /api/* require it
const checkApiKey = (req, res, next) => {
  if (!API_KEY) return next(); // only when REQUIRE_API_KEY=0 and empty key
  const clientKey = req.headers['x-api-key'] || req.query.api_key || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (clientKey && clientKey === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key (header x-api-key)' });
};

// Helper to run shell / python commands
function runCommand(cmd, args = [], stdinData = null, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const proc = spawn(cmd, args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
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

// --- REST ENDPOINTS ---

// Health & Info
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
    mode: 'line-exec (colab exec per command — not a persistent PTY shell)'
  });
});

// System Overview & Auth Status
app.get('/api/status', checkApiKey, async (req, res) => {
  const authRes = await runCommand('python3', [HELPER_SCRIPT, 'status'], null, 5000);
  let authData = { authenticated: false };
  try {
    authData = JSON.parse(authRes.stdout.trim());
  } catch (e) {
    authData = { error: authRes.stderr || 'Status parse error', authenticated: false };
  }

  let sessions = [];
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const sessJson = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      sessions = Object.values(sessJson);
    } catch (e) {}
  }

  res.json({
    auth: authData,
    sessionsCount: sessions.length,
    sessions,
    serverUptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Auth Endpoints
app.get('/api/auth/status', checkApiKey, async (req, res) => {
  const result = await runCommand('python3', [HELPER_SCRIPT, 'status'], null, 8000);
  try {
    const data = JSON.parse(result.stdout.trim());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to inspect auth status', details: result.stderr });
  }
});

app.get('/api/auth/login-url', checkApiKey, async (req, res) => {
  const result = await runCommand('python3', [HELPER_SCRIPT, 'generate-url'], null, 10000);
  try {
    const data = JSON.parse(result.stdout.trim());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate OAuth URL', details: result.stderr });
  }
});

app.post('/api/auth/code', checkApiKey, async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Authorization code is required' });
  }
  const result = await runCommand('python3', [HELPER_SCRIPT, 'exchange-code', code.trim()], null, 15000);
  try {
    const data = JSON.parse(result.stdout.trim());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to exchange code', details: result.stderr });
  }
});

app.post('/api/auth/token', checkApiKey, async (req, res) => {
  const tokenData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const result = await runCommand('python3', [HELPER_SCRIPT, 'save-token'], tokenData, 5000);
  try {
    const data = JSON.parse(result.stdout.trim());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save token', details: result.stderr });
  }
});

app.delete('/api/auth', checkApiKey, (req, res) => {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    res.json({ success: true, message: 'Google Colab credentials removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Session Management
app.get('/api/sessions', checkApiKey, async (req, res) => {
  // First read local state cache if exists
  let localSessions = {};
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      localSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch (e) {}
  }

  // Also query colab sessions CLI
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

  if (gpu && gpu !== 'NONE') {
    args.push('--gpu', gpu);
  } else if (tpu && tpu !== 'NONE') {
    args.push('--tpu', tpu);
  }

  if (highMem) {
    args.push('--high-mem');
  }

  console.log(`[COLAB-BACKEND] Provisioning session: colab ${args.join(' ')}`);
  const result = await runCommand('colab', args, null, 60000);

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
  res.json({
    sessionName,
    output: result.stdout || result.stderr,
    success: result.success
  });
});

app.delete('/api/sessions/:name', checkApiKey, async (req, res) => {
  const sessionName = req.params.name;
  console.log(`[COLAB-BACKEND] Stopping session: ${sessionName}`);
  const result = await runCommand('colab', ['stop', '-s', sessionName], null, 30000);
  res.json({
    sessionName,
    success: result.success,
    output: result.stdout || result.stderr
  });
});

app.post('/api/sessions/:name/restart', checkApiKey, async (req, res) => {
  const sessionName = req.params.name;
  const result = await runCommand('colab', ['restart-kernel', '-s', sessionName], null, 20000);
  res.json({
    sessionName,
    success: result.success,
    output: result.stdout || result.stderr
  });
});

app.get('/api/sessions/:name/url', checkApiKey, async (req, res) => {
  const sessionName = req.params.name;
  const result = await runCommand('colab', ['url', '-s', sessionName], null, 10000);
  res.json({
    sessionName,
    url: result.stdout.trim(),
    success: result.success
  });
});

// Command Execution
app.post('/api/exec', checkApiKey, async (req, res) => {
  let { session, code, isBash, timeout } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Code or command is required' });
  }

  // Format code if bash is requested
  let execCode = code;
  if (isBash) {
    // If multiline bash or single command
    if (code.includes('\n')) {
      execCode = '%%bash\n' + code;
    } else {
      execCode = code.startsWith('!') ? code : '!' + code;
    }
  }

  const timeoutMs = (timeout || 60) * 1000;
  const args = ['exec'];
  if (session) {
    args.push('-s', session);
  }

  console.log(`[COLAB-BACKEND] Executing on session '${session || 'default'}': ${code.substring(0, 80)}...`);
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

// Streaming Execution via Server-Sent Events (SSE)
app.post('/api/exec/stream', checkApiKey, (req, res) => {
  let { session, code, isBash, timeout } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Code or command is required' });
  }

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

  proc.stdout.on('data', (d) => {
    sendEvent('stdout', d.toString());
  });

  proc.stderr.on('data', (d) => {
    sendEvent('stderr', d.toString());
  });

  proc.on('close', (code) => {
    sendEvent('close', { exitCode: code });
    res.end();
  });

  proc.on('error', (err) => {
    sendEvent('error', { error: err.message });
    res.end();
  });

  req.on('close', () => {
    proc.kill('SIGTERM');
  });
});

// Hardware & GPU Monitoring
app.get('/api/gpu', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const args = ['exec'];
  if (session) args.push('-s', session);

  const queryCmd = '!nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu,utilization.memory --format=csv,noheader,nounits';
  const result = await runCommand('colab', args, queryCmd, 15000);

  if (!result.success || !result.stdout) {
    return res.json({
      hasGpu: false,
      raw: result.stdout || result.stderr,
      message: 'No GPU detected or command failed'
    });
  }

  try {
    const lines = result.stdout.trim().split('\n').filter(l => l.trim().length > 0);
    const gpus = lines.map(line => {
      const parts = line.split(',').map(p => p.trim());
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

// System Specs Monitor
app.get('/api/system', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const args = ['exec'];
  if (session) args.push('-s', session);

  const sysCmd = '!echo "===CPU===" && lscpu | head -n 15 && echo "===MEM===" && free -m && echo "===DISK===" && df -h /content && echo "===OS===" && uname -a';
  const result = await runCommand('colab', args, sysCmd, 15000);

  res.json({
    success: result.success,
    raw: result.stdout || result.stderr
  });
});

// Compute Unit Usage
app.get('/api/usage', checkApiKey, async (req, res) => {
  const result = await runCommand('colab', ['usage'], null, 10000);
  res.json({
    output: result.stdout || result.stderr,
    success: result.success
  });
});

// File Management
app.get('/api/files', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const remotePath = req.query.path || '/content';
  const args = ['ls'];
  if (session) args.push('-s', session);
  args.push(remotePath);

  const result = await runCommand('colab', args, null, 15000);
  res.json({
    path: remotePath,
    output: result.stdout || result.stderr,
    success: result.success
  });
});

app.get('/api/files/download', checkApiKey, async (req, res) => {
  const session = req.query.session;
  const remotePath = req.query.path;
  if (!remotePath) return res.status(400).json({ error: 'path parameter is required' });

  const fileName = path.basename(remotePath);
  const localDest = path.join('/tmp', 'dl_' + Date.now() + '_' + fileName);

  const args = ['download'];
  if (session) args.push('-s', session);
  args.push(remotePath, localDest);

  const result = await runCommand('colab', args, null, 30000);
  if (!result.success || !fs.existsSync(localDest)) {
    return res.status(500).json({ error: 'Download failed', details: result.stderr });
  }

  res.download(localDest, fileName, () => {
    fs.unlink(localDest, () => {});
  });
});

app.post('/api/files/upload', checkApiKey, upload.single('file'), async (req, res) => {
  const session = req.body.session;
  const remotePath = req.body.remotePath || '/content';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const targetRemote = path.posix.join(remotePath, req.file.originalname);
  const args = ['upload'];
  if (session) args.push('-s', session);
  args.push(req.file.path, targetRemote);

  const result = await runCommand('colab', args, null, 30000);
  fs.unlink(req.file.path, () => {});

  res.json({
    success: result.success,
    remotePath: targetRemote,
    output: result.stdout || result.stderr
  });
});

// Package Installation
app.post('/api/install', checkApiKey, async (req, res) => {
  const { session, packages } = req.body;
  if (!packages) return res.status(400).json({ error: 'packages list is required' });

  const pkgList = Array.isArray(packages) ? packages : packages.trim().split(/\s+/);
  const args = ['install'];
  if (session) args.push('-s', session);
  args.push(...pkgList);

  const result = await runCommand('colab', args, null, 120000);
  res.json({
    success: result.success,
    output: result.stdout || result.stderr,
    durationMs: result.durationMs
  });
});

// --- WEBSOCKET TERMINAL SERVER ---

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const session = url.searchParams.get('session') || '';
  const clientKey = url.searchParams.get('api_key') || '';

  if (API_KEY && clientKey !== API_KEY) {
    ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized: Invalid API Key\r\n' }));
    return ws.close();
  }

  let activeChild = null;

  ws.send(JSON.stringify({
    type: 'banner',
    data: `\x1b[32;1m[COLAB HACKER TERMINAL ONLINE]\x1b[0m\r\n` +
          `\x1b[36mTarget Session: ${session || 'DEFAULT'}\x1b[0m\r\n` +
          `\x1b[90mPowered by Google Colab CLI & Northflank\x1b[0m\r\n` +
          `\x1b[33mMode: line-exec (each line → colab exec). Not a persistent interactive shell.\x1b[0m\r\n\r\n`
  }));

  ws.on('message', async (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());

      if (msg.type === 'exec') {
        const cmd = msg.command || '';
        const isBash = msg.isBash !== false; // Default to bash mode
        const targetSession = msg.session || session;

        if (cmd === 'clear') {
          return ws.send(JSON.stringify({ type: 'clear' }));
        }

        // Format code
        let execCode = cmd;
        if (isBash) {
          execCode = cmd.includes('\n') ? '%%bash\n' + cmd : (cmd.startsWith('!') ? cmd : '!' + cmd);
        }

        const args = ['exec'];
        if (targetSession) args.push('-s', targetSession);

        ws.send(JSON.stringify({
          type: 'exec_start',
          command: cmd,
          session: targetSession
        }));

        activeChild = spawn('colab', args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } });
        activeChild.stdin.write(execCode);
        activeChild.stdin.end();

        activeChild.stdout.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'stdout', data: data.toString() }));
        });

        activeChild.stderr.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'stderr', data: data.toString() }));
        });

        activeChild.on('close', (exitCode) => {
          activeChild = null;
          ws.send(JSON.stringify({
            type: 'exec_end',
            exitCode,
            data: `\r\n\x1b[90m[Process completed with exit code ${exitCode}]\x1b[0m\r\n`
          }));
        });

        activeChild.on('error', (err) => {
          activeChild = null;
          ws.send(JSON.stringify({
            type: 'error',
            data: `\r\n\x1b[31;1mError: ${err.message}\x1b[0m\r\n`
          }));
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
      activeChild.kill('SIGTERM');
      activeChild = null;
    }
  });
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`⚡ GOOGLE COLAB CLI BACKEND (NORTHFLANK) RUNNING`);
  console.log(`⚡ Port: ${PORT}`);
  console.log(`⚡ API key required: ${Boolean(API_KEY)}`);
  console.log(`⚡ Config dir: ${CONFIG_DIR}`);
  console.log(`⚡ Mode: line-exec (colab exec), not persistent PTY`);
  console.log(`⚡ WebSocket: /terminal?session=NAME&api_key=...`);
  console.log(`======================================================\n`);
});
