// This file is managed by PhantomWP infrastructure. It will be overwritten on update. Do not edit it manually.
// Source of truth lives in PhantomWP infrastructure generators.

import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';

const execFileAsync = promisify(execFile);
const PORT = 8080;
const WORKSPACE_DIR = process.cwd();

// Prettier formatter (lazy-loaded)
let prettierInstance = null;
let prettierAstroPlugin = null;

async function loadPrettier() {
  if (!prettierInstance) {
    try {
      const prettierMod = await import('prettier');
      prettierInstance = prettierMod.default || prettierMod;
      const astroMod = await import('prettier-plugin-astro');
      prettierAstroPlugin = astroMod.default || astroMod;
      console.log('✅ Prettier + Astro plugin loaded');
    } catch (e) {
      console.log('⚠️  Prettier not available: ' + e.message);
    }
  }
  return { prettier: prettierInstance, astroPlugin: prettierAstroPlugin };
}

// Terminal session management
const terminalSessions = new Map();
let ptyModule = null;

// Try to load node-pty for proper terminal support
try {
  const mod = await import('node-pty');
  ptyModule = mod.default || mod;
  // Verify the spawn function actually exists
  if (typeof ptyModule.spawn !== 'function') {
    throw new Error('spawn function not found on node-pty module');
  }
  console.log('✅ node-pty loaded - full terminal support available');
} catch (e) {
  ptyModule = null;
  console.log('⚠️  node-pty not available (' + e.message + ') - install with: npm install node-pty');
}

// JWT Public Key(s) for token verification (RS256)
// Supports multiple keys for rolling key rotation
const jwtPublicKeys = [];

function validatePhantomUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
const PHANTOMWP_URL = validatePhantomUrl(process.env.PHANTOMWP_URL || '') || 'https://phantomwp.com';
const KEY_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // Refresh keys every 6 hours

function isValidPublicKey(key) {
  return key && (key.includes('BEGIN PUBLIC KEY') || key.includes('BEGIN RSA PUBLIC KEY'));
}

// Load initial key from environment
const envKey = process.env.JWT_PUBLIC_KEY;
if (envKey && isValidPublicKey(envKey)) {
  jwtPublicKeys.push(envKey);
  console.log('🔐 JWT public key loaded from environment');
} else if (envKey) {
  console.error('⚠️  JWT_PUBLIC_KEY from environment is not a valid PEM public key');
}

// Fetch keys from the PhantomWP API (supports key rotation)
async function refreshPublicKeys() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(PHANTOMWP_URL + '/api/keys/public', { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error('⚠️  Key refresh: API returned ' + res.status);
      return;
    }
    const data = await res.json();
    if (!data.keys || !Array.isArray(data.keys)) return;

    const newKeys = data.keys
      .map(k => k.key)
      .filter(k => isValidPublicKey(k));

    if (newKeys.length > 0) {
      // Replace the key list with the fresh set from the API
      jwtPublicKeys.length = 0;
      newKeys.forEach(k => jwtPublicKeys.push(k));
      console.log('🔑 Refreshed ' + newKeys.length + ' public key(s) from API');
    }
  } catch (error) {
    // Network errors are expected when the main app is unreachable; not fatal
    if (error.name !== 'AbortError') {
      console.error('⚠️  Key refresh failed:', error.message);
    }
  }
}

// Try an initial fetch (non-blocking -- we already have the env key as fallback)
refreshPublicKeys().catch(() => {});

// Periodically refresh keys to pick up rotations
setInterval(() => { refreshPublicKeys().catch(() => {}); }, KEY_REFRESH_INTERVAL);

if (jwtPublicKeys.length === 0) {
  console.error('❌ No JWT public keys available');
  console.error('');
  console.error('This codespace requires JWT authentication to be set up.');
  console.error('The public key should be fetched automatically from the PhantomWP API.');
  console.error('');
  console.error('If you see this error:');
  console.error('  1. Try recreating the codespace from the PhantomWP dashboard');
  console.error('  2. Check that the main app has JWT_PUBLIC_KEY set');
  console.error('');
  process.exit(1);
}

console.log('🔐 ' + jwtPublicKeys.length + ' JWT public key(s) loaded for WebSocket authentication');
console.log('   Using RS256 asymmetric verification');
console.log('   Keys refresh every ' + (KEY_REFRESH_INTERVAL / 3600000) + ' hours from ' + PHANTOMWP_URL);

const CONTAINER_REPO_ID = process.env.CONTAINER_REPO_ID || '';
if (CONTAINER_REPO_ID) {
  console.log('🔒 Container bound to repo ID ' + CONTAINER_REPO_ID);
}

// Pending IDE command responses (for request/response commands like get-open-tabs)
const pendingResponses = new Map();

function isOriginAllowed(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.origin === PHANTOMWP_URL) return true;
    const host = parsed.hostname;
    const suffixes = ['.fly.dev', '.app.github.dev', 'localhost', '127.0.0.1'];
    return suffixes.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function getCorsOriginHeaders(origin) {
  if (!origin || !isOriginAllowed(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

// HTTP server for IDE command bridge (localhost only, used by MCP server)
const httpServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '';
    const allowed = origin !== '' && isOriginAllowed(origin);
    const reqHeaders = req.headers['access-control-request-headers'];
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': reqHeaders || 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin, Access-Control-Request-Headers',
      ...(allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...(allowed && req.headers['access-control-request-private-network'] === 'true'
        ? { 'Access-Control-Allow-Private-Network': 'true' }
        : {}),
    };
    res.writeHead(allowed ? 204 : 403, headers);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/ide-command') {
    // Only allow localhost connections (MCP server runs locally)
    const addr = req.socket.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
      return;
    }
    let body = '';
    const MAX_BODY = 4096;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const command = JSON.parse(body);
        // For commands that expect a response, add a request ID and wait
        const needsResponse = command.command === 'get-open-tabs';
        const requestId = needsResponse ? Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : null;
        if (requestId) command._requestId = requestId;

        // Broadcast to all authenticated WebSocket clients
        let sent = 0;
        for (const client of wss.clients) {
          if (client.readyState === 1 && client.username) {
            client.send(JSON.stringify({ action: 'ide-command', ...command }));
            sent++;
          }
        }

        if (needsResponse && sent > 0) {
          // Wait up to 3s for IDE to respond
          const timeout = setTimeout(() => {
            pendingResponses.delete(requestId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, clients: sent, data: null }));
          }, 3000);
          pendingResponses.set(requestId, { res, timeout });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, clients: sent }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    const origin = req.headers.origin || '';
    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...getCorsOriginHeaders(origin),
    });
    res.end(JSON.stringify({
      status: 'ok',
      ready: jwtPublicKeys.length > 0,
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(PORT);

const wss = new WebSocketServer({ 
  server: httpServer,
  maxPayload: 50 * 1024 * 1024,
});

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 1000;

function checkRateLimit(ws) {
  const now = Date.now();
  if (!ws._rlWindowStart || now - ws._rlWindowStart >= RATE_LIMIT_WINDOW_MS) {
    ws._rlWindowStart = now;
    ws._rlCount = 1;
    return true;
  }
  ws._rlCount++;
  return ws._rlCount <= RATE_LIMIT_MAX;
}

// Verify JWT token against all known public keys (RS256)
// Tries each key in order -- supports rolling key rotation
function verifyToken(token) {
  let lastError = null;
  for (const key of jwtPublicKeys) {
    try {
      const decoded = jwt.verify(token, key, {
        algorithms: ['RS256'],
        issuer: 'phantomwp',
        audience: 'websocket',
      });
      return { valid: true, payload: decoded };
    } catch (error) {
      lastError = error;
    }
  }
  console.error('JWT verification failed against all ' + jwtPublicKeys.length + ' key(s):', lastError?.message);
  return { valid: false, error: lastError?.message || 'No valid keys' };
}

// Extract token from URL query parameter
function authenticateConnection(req) {
  try {
    if (!isOriginAllowed(req.headers.origin || '')) {
      console.error('❌ Disallowed origin:', req.headers.origin || '(missing)');
      return null;
    }

    const url = new URL(req.url, 'ws://localhost');
    const token = url.searchParams.get('token');
    
    if (!token) {
      console.error('❌ No token provided in connection URL');
      return null;
    }
    
    const result = verifyToken(token);
    if (!result.valid) {
      console.error('❌ Invalid token:', result.error);
      return null;
    }

    if (CONTAINER_REPO_ID && String(result.payload.repoId) !== CONTAINER_REPO_ID) {
      console.error('❌ Token repoId ' + result.payload.repoId + ' does not match container repo ' + CONTAINER_REPO_ID);
      return null;
    }
    
    return {
      userId: result.payload.userId,
      username: result.payload.username || 'unknown',
      repoId: result.payload.repoId,
      repoName: result.payload.repoName,
    };
  } catch (error) {
    console.error('❌ Authentication error:', error.message);
    return null;
  }
}

// Resolve and validate a workspace-relative path
function assertSafeWorkspacePath(workspaceDir, filePath) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    throw new Error('Workspace directory is required');
  }
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Path must be relative to the workspace root');
  }
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = path.resolve(resolvedWorkspaceDir, filePath);
  const relativePath = path.relative(resolvedWorkspaceDir, resolvedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Path escapes workspace root');
  }
  const blockedRoots = new Set(['.git', 'node_modules', '.npmrc', '.docker-infra']);
  const [firstSegment] = relativePath.split(path.sep).filter(Boolean);
  if (firstSegment && blockedRoots.has(firstSegment)) {
    throw new Error('Path is blocked: ' + filePath);
  }
  return resolvedPath;
}

function isPathSafe(filePath) {
  try {
    assertSafeWorkspacePath(WORKSPACE_DIR, filePath);
    return true;
  } catch {
    return false;
  }
}

function sendWsResponse(ws, request, payload) {
  const response = request?._requestId
    ? { ...payload, _requestId: request._requestId }
    : payload;
  ws.send(JSON.stringify(response));
}

/**
 * Legacy quote-aware tokenizer retained for the git command channel which
 * bypasses the exec policy entirely (git subcommands have their own
 * allowlist downstream). Do NOT use for exec-policy validation; use
 * parseShellTokens instead.
 */
function tokenizeCommand(command) {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(token =>
    token.replace(/^['"]|['"]$/g, '')
  );
}

/**
 * Quote- and operator-aware tokenizer that mirrors the subset of shell
 * grammar we allow: plain strings, single/double quoted strings, pipelines
 * (`|`), and the whitelisted redirect operators (`>`, `<`, `>&`).
 * Anything else is emitted as an operator token so the policy layer can
 * reject it by name instead of by raw character.
 */
function parseShellTokens(command) {
  const tokens = [];
  let i = 0;
  let current = '';
  let hasGlobChar = false;

  const flushCurrent = () => {
    if (current === '') return;
    if (hasGlobChar) {
      tokens.push({ op: 'glob', pattern: current });
    } else {
      tokens.push(current);
    }
    current = '';
    hasGlobChar = false;
  };

  while (i < command.length) {
    const ch = command[i];
    if (ch === ' ' || ch === '\t') {
      flushCurrent();
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error('Unterminated single quote in command');
      current += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) throw new Error('Unterminated double quote in command');
      current += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '|') {
      flushCurrent();
      if (command[i + 1] === '|') { tokens.push({ op: '||' }); i += 2; continue; }
      tokens.push({ op: '|' });
      i += 1;
      continue;
    }
    if (ch === '&') {
      flushCurrent();
      if (command[i + 1] === '&') { tokens.push({ op: '&&' }); i += 2; continue; }
      tokens.push({ op: '&' });
      i += 1;
      continue;
    }
    if (ch === ';') {
      flushCurrent();
      tokens.push({ op: ';' });
      i += 1;
      continue;
    }
    if (ch === '>') {
      flushCurrent();
      if (command[i + 1] === '&') { tokens.push({ op: '>&' }); i += 2; continue; }
      if (command[i + 1] === '(') { tokens.push({ op: '>(' }); i += 2; continue; }
      tokens.push({ op: '>' });
      i += 1;
      continue;
    }
    if (ch === '<') {
      flushCurrent();
      if (command[i + 1] === '(') { tokens.push({ op: '<(' }); i += 2; continue; }
      tokens.push({ op: '<' });
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      flushCurrent();
      tokens.push({ op: ch });
      i += 1;
      continue;
    }
    if (ch === '*' || ch === '?') {
      hasGlobChar = true;
      current += ch;
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flushCurrent();
  return tokens;
}

function normalizeLegacyCommand(command) {
  const workspaceInstallMatch = command.match(/^cd \/workspaces\/\* && (npm (install|uninstall)\s+.+)$/);
  if (workspaceInstallMatch) {
    return workspaceInstallMatch[1];
  }
  return command;
}

const COMMAND_POLICY_WORKSPACE = '/workspace';
const searchOptionsWithValues = new Set([
  '-A', '-B', '-C', '-g', '-m', '-t', '--context', '--exclude',
  '--exclude-dir', '--glob', '--include', '--max-count', '--max-filesize', '--type',
]);
const genericOptionsWithValues = new Set(['-c', '-k', '-n', '--bytes', '--lines']);

// Patterns that indicate code-injection surface beyond what parseShellTokens
// can reject operator-by-operator (backticks survive tokenization because
// they have no standalone operator in our grammar).
const forbiddenCommandPatterns = [
  { pattern: /`/, reason: 'backtick command substitution is not allowed' },
  { pattern: /\$\(/, reason: '$() command substitution is not allowed' },
  { pattern: /\\/, reason: 'backslash escapes are not allowed' },
  { pattern: /(^|\s)~/, reason: 'tilde expansion is not allowed' },
];

// Narrow pm2 subcommand allowlist so the agent can tail / restart our
// managed processes without opening pm2 generally.
const pm2Services = new Set(['astro', 'websocket']);
const pm2Subcommands = {
  restart: { approvalRequired: false, timeoutMs: 30000, allowedFlags: new Set(), flagsWithValues: new Set() },
  stop: { approvalRequired: false, timeoutMs: 30000, allowedFlags: new Set(), flagsWithValues: new Set() },
  flush: { approvalRequired: false, timeoutMs: 30000, allowedFlags: new Set(), flagsWithValues: new Set() },
  logs: {
    approvalRequired: false,
    timeoutMs: 30000,
    allowedFlags: new Set(['--nostream', '--raw', '--err', '--out']),
    flagsWithValues: new Set(['--lines', '-l']),
  },
};

const npxAllowed = [
  { match: ['astro', 'check'], approvalRequired: false, timeoutMs: 120000 },
];

function assertSafeExecPath(candidate) {
  assertSafeWorkspacePath(COMMAND_POLICY_WORKSPACE, candidate);
}

function validateGenericReadOnlyArgs(args) {
  let pendingValueForOption = false;

  for (const arg of args) {
    if (pendingValueForOption) {
      pendingValueForOption = false;
      continue;
    }

    if (arg.startsWith('-')) {
      const [optionName] = arg.split('=', 1);
      if (genericOptionsWithValues.has(optionName) && !arg.includes('=')) {
        pendingValueForOption = true;
      }
      continue;
    }

    if (/^\d+$/.test(arg)) {
      continue;
    }

    assertSafeExecPath(arg);
  }
}

function validateSearchArgs(args) {
  let pendingValueForOption = false;
  let sawPattern = false;

  for (const arg of args) {
    if (pendingValueForOption) {
      pendingValueForOption = false;
      continue;
    }

    if (arg.startsWith('-')) {
      const [optionName] = arg.split('=', 1);
      if (searchOptionsWithValues.has(optionName) && !arg.includes('=')) {
        pendingValueForOption = true;
      }
      continue;
    }

    if (!sawPattern) {
      sawPattern = true;
      continue;
    }

    assertSafeExecPath(arg);
  }
}

function validateFindArgs(args) {
  let expressionStarted = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!expressionStarted && !arg.startsWith('-')) {
      assertSafeExecPath(arg);
      continue;
    }

    expressionStarted = true;

    if (arg === '-not') {
      continue;
    }

    if (arg === '-name' || arg === '-iname') {
      const pattern = args[index + 1];
      if (!pattern) {
        throw new Error('Find option requires a value: ' + arg);
      }
      index += 1;
      continue;
    }

    if (arg === '-type') {
      const fileType = args[index + 1];
      if (!fileType || !/^[bcdfpls]$/.test(fileType)) {
        throw new Error('Find type is not allowed: ' + (fileType || ''));
      }
      index += 1;
      continue;
    }

    if (arg === '-maxdepth' || arg === '-mindepth') {
      const depth = args[index + 1];
      if (!depth || !/^\d+$/.test(depth)) {
        throw new Error('Find depth must be numeric: ' + (depth || ''));
      }
      index += 1;
      continue;
    }

    throw new Error('Find option is not allowed: ' + arg);
  }
}

function validateReadOnlyArgs(bin, args) {
  switch (bin) {
    case 'grep':
    case 'rg':
      validateSearchArgs(args);
      return;
    case 'find':
      validateFindArgs(args);
      return;
    case 'pwd':
    case 'which':
    case 'echo':
      return;
    default:
      validateGenericReadOnlyArgs(args);
  }
}

const exactCompat = new Map([
  ['pm2 restart astro', { bin: 'pm2', args: ['restart', 'astro'], approvalRequired: false, timeoutMs: 30000 }],
]);

const legacyShellCompat = new Map([
  ['pm2 logs astro --lines 200 --nostream 2>&1 || cat ~/.pm2/logs/astro-error.log 2>/dev/null | tail -200 || echo "No Astro logs found"', { approvalRequired: false, timeoutMs: 30000 }],
  ['pm2 flush astro 2>/dev/null', { approvalRequired: false, timeoutMs: 30000 }],
  ['chmod +x .devcontainer/*.sh .devcontainer/phantomwp-ide 2>/dev/null; (sudo ln -sf "$(pwd)/.devcontainer/phantomwp-ide" /usr/local/bin/phantomwp-ide 2>/dev/null || ln -sf "$(pwd)/.devcontainer/phantomwp-ide" "$HOME/.local/bin/phantomwp-ide" 2>/dev/null || true)', { approvalRequired: true, timeoutMs: 120000 }],
  ['npm ls prettier >/dev/null 2>&1 || npm install --save-dev prettier prettier-plugin-astro 2>&1; npm ls @astrojs/check >/dev/null 2>&1 || npm install --save-dev @astrojs/check 2>&1; true', { approvalRequired: true, timeoutMs: 120000 }],
  ['pm2 restart astro 2>/dev/null || true', { approvalRequired: false, timeoutMs: 30000 }],
  ['pm2 restart websocket 2>/dev/null || true', { approvalRequired: false, timeoutMs: 30000 }],
  ['pm2 restart astro 2>/dev/null || (pkill -f "astro dev" 2>/dev/null; sleep 1; cd /workspaces/* && npm run dev > /dev/null 2>&1 &)', { approvalRequired: false, timeoutMs: 120000 }],
  ['pm2 stop astro 2>/dev/null; pkill -f "astro dev" 2>/dev/null; sleep 2; pm2 start astro 2>/dev/null || (cd /workspaces/* && npm run dev > /dev/null 2>&1 &)', { approvalRequired: false, timeoutMs: 120000 }],
  ['curl -fsSL https://claude.ai/install.sh | bash', { approvalRequired: true, timeoutMs: 120000 }],
  ['which claude 2>/dev/null && echo YES || echo NO', { approvalRequired: false, timeoutMs: 30000 }],
  ['npx astro check 2>&1; true', { approvalRequired: false, timeoutMs: 120000 }],
]);

const alwaysAllowedBins = new Set([
  'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'which', 'grep', 'rg', 'find',
  'sort', 'uniq', 'diff', 'echo', 'file',
]);

const curlBlockedFlags = new Set([
  '-o', '--output',
  '-O', '--remote-name',
  '--remote-name-all',
  '--output-dir',
  '--create-dirs',
  '-T', '--upload-file',
  '-K', '--config',
  '-c', '--cookie-jar',
  '-D', '--dump-header',
  '--trace', '--trace-ascii', '--trace-config',
  '--etag-save', '--etag-compare',
  '--cert', '-E',
  '--key',
  '--cacert',
  '--capath',
  '--pinnedpubkey',
  '--next',
  '--parallel-config',
  '--libcurl',
]);

const curlFileRefFlags = new Set([
  '-d', '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--data-ascii',
  '--json',
  '-F', '--form',
  '--form-string',
  '-H', '--header',
  '-b', '--cookie',
  '--url-query',
]);

function validateCurlArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') continue;
    const [flag] = arg.split('=', 1);
    if (curlBlockedFlags.has(flag)) {
      throw new Error('curl flag is not allowed: ' + flag);
    }
    if (curlFileRefFlags.has(flag)) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1];
      if (typeof value === 'string' && value.startsWith('@')) {
        throw new Error('curl ' + flag + ' @file references are not allowed');
      }
    }
  }
}

function validatePm2Segment(args) {
  const [sub, service, ...rest] = args;
  const subConfig = sub ? pm2Subcommands[sub] : undefined;
  if (!subConfig) {
    throw new Error('pm2 subcommand is not allowed: ' + (sub || ''));
  }
  if (!service || !pm2Services.has(service)) {
    throw new Error('pm2 service is not allowed: ' + (service || ''));
  }
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (subConfig.allowedFlags.has(flag)) continue;
    if (subConfig.flagsWithValues.has(flag)) {
      const value = rest[i + 1];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error('pm2 ' + sub + ' flag ' + flag + ' requires a numeric value');
      }
      i += 1;
      continue;
    }
    throw new Error('pm2 ' + sub + ' flag is not allowed: ' + flag);
  }
  return { approvalRequired: subConfig.approvalRequired, timeoutMs: subConfig.timeoutMs };
}

function validateNpxSegment(args) {
  for (const entry of npxAllowed) {
    if (args.length === entry.match.length && entry.match.every((tok, i) => args[i] === tok)) {
      return { approvalRequired: entry.approvalRequired, timeoutMs: entry.timeoutMs };
    }
  }
  throw new Error('npx invocation is not allowed: ' + args.join(' '));
}

// Script paths that the AI agent is allowed to execute via `node <script>`.
// Listed by relative path so we can accept arbitrary CLI flags after the
// script path without funnelling them through validateGenericReadOnlyArgs
// (which rejects leading-slash values like `--path /about`).
const allowedNodeScripts = new Set([
  '.devcontainer/screenshot/screenshot.mjs',
  '/opt/phantomwp/screenshot/screenshot.mjs',
]);

function validateNodeSegment(args) {
  const script = args[0];
  if (!script || typeof script !== 'string') {
    throw new Error('node invocation requires a script path');
  }
  if (!allowedNodeScripts.has(script)) {
    throw new Error('node script is not allowed: ' + script);
  }
  return { approvalRequired: false, timeoutMs: 60000 };
}

function validateSegment(bin, args) {
  if (alwaysAllowedBins.has(bin)) {
    validateReadOnlyArgs(bin, args);
    return { approvalRequired: false, timeoutMs: 30000 };
  }
  if (bin === 'pm2') return validatePm2Segment(args);
  if (bin === 'npx') return validateNpxSegment(args);
  if (bin === 'node') return validateNodeSegment(args);
  if (bin === 'curl') {
    validateCurlArgs(args);
    return { approvalRequired: false, timeoutMs: 60000 };
  }
  if (bin === 'npm' && ['install', 'uninstall', 'run'].includes(args[0] || '')) {
    return { approvalRequired: true, timeoutMs: 120000 };
  }
  throw new Error('Command is not allowed: ' + bin);
}

function quoteIfNeeded(token) {
  if (token === '') return "''";
  if (/^[A-Za-z0-9_\-/:.=@,+]+$/.test(token)) return token;
  return "'" + token.replace(/'/g, "'\\''") + "'";
}

function isOp(token, op) {
  return typeof token === 'object' && token !== null && 'op' in token && token.op === op;
}

function stripTrailingRedirect(segmentTokens) {
  const n = segmentTokens.length;
  if (n >= 3 && segmentTokens[n - 3] === '2' && isOp(segmentTokens[n - 2], '>&') && segmentTokens[n - 1] === '1') {
    return { stripped: segmentTokens.slice(0, n - 3), render: '2>&1' };
  }
  if (n >= 3 && segmentTokens[n - 3] === '2' && isOp(segmentTokens[n - 2], '>') && segmentTokens[n - 1] === '/dev/null') {
    return { stripped: segmentTokens.slice(0, n - 3), render: '2>/dev/null' };
  }
  if (n >= 2 && isOp(segmentTokens[n - 2], '>') && segmentTokens[n - 1] === '/dev/null') {
    return { stripped: segmentTokens.slice(0, n - 2), render: '>/dev/null' };
  }
  if (n >= 2 && isOp(segmentTokens[n - 2], '<') && segmentTokens[n - 1] === '/dev/null') {
    return { stripped: segmentTokens.slice(0, n - 2), render: '</dev/null' };
  }
  return null;
}

function splitIntoSegments(tokens) {
  const segments = [];
  const renderedParts = [];
  let currentTokens = [];

  const flushCurrent = () => {
    if (currentTokens.length === 0) {
      throw new Error('Pipeline segment is empty');
    }
    const trailingRenders = [];
    let stripped = true;
    while (stripped) {
      stripped = false;
      const result = stripTrailingRedirect(currentTokens);
      if (result) {
        currentTokens = result.stripped;
        trailingRenders.unshift(result.render);
        stripped = true;
      }
    }
    const stringTokens = [];
    for (const tok of currentTokens) {
      if (typeof tok === 'string') {
        stringTokens.push(tok);
        continue;
      }
      if (tok && tok.op === 'glob' && typeof tok.pattern === 'string') {
        stringTokens.push(tok.pattern);
        continue;
      }
      if (tok && typeof tok.op === 'string') {
        throw new Error('Shell operator is not allowed: ' + tok.op);
      }
      throw new Error('Unsupported shell token in command');
    }
    if (stringTokens.length === 0) {
      throw new Error('Pipeline segment has no command');
    }
    const [bin, ...args] = stringTokens;
    segments.push({ bin, args, rawTokens: stringTokens });
    const rendered = [...stringTokens.map(quoteIfNeeded), ...trailingRenders].join(' ');
    renderedParts.push(rendered);
    currentTokens = [];
  };

  for (const token of tokens) {
    if (isOp(token, '|')) {
      flushCurrent();
      renderedParts.push('|');
      continue;
    }
    currentTokens.push(token);
  }
  flushCurrent();

  return { segments, reassembled: renderedParts.join(' ') };
}

function parseExecCommand(command) {
  if (!command || typeof command !== 'string') {
    throw new Error('Command is required');
  }
  const trimmed = normalizeLegacyCommand(command.trim());
  if (!trimmed) {
    throw new Error('Command is required');
  }
  const exact = exactCompat.get(trimmed);
  if (exact) {
    return exact;
  }
  const compat = legacyShellCompat.get(trimmed);
  if (compat) {
    return { bin: '/bin/sh', args: ['-lc', trimmed], approvalRequired: compat.approvalRequired, timeoutMs: compat.timeoutMs };
  }
  for (const { pattern, reason } of forbiddenCommandPatterns) {
    if (pattern.test(trimmed)) {
      throw new Error('Command is not allowed: ' + reason);
    }
  }
  const tokens = parseShellTokens(trimmed);
  if (tokens.length === 0) {
    throw new Error('Command is required');
  }
  const { segments, reassembled } = splitIntoSegments(tokens);
  let approvalRequired = false;
  let timeoutMs = 30000;
  for (const segment of segments) {
    const result = validateSegment(segment.bin, segment.args);
    if (result.approvalRequired) approvalRequired = true;
    if (result.timeoutMs > timeoutMs) timeoutMs = result.timeoutMs;
  }
  if (segments.length === 1) {
    const segment = segments[0];
    const directForm = segment.rawTokens.map(quoteIfNeeded).join(' ');
    if (directForm === reassembled) {
      return { bin: segment.bin, args: segment.args, approvalRequired, timeoutMs };
    }
  }
  return { bin: '/bin/sh', args: ['-lc', reassembled], approvalRequired, timeoutMs };
}

const GIT_CRED_PATH = path.join(WORKSPACE_DIR, '.git', '.git-credentials');
const GIT_REFRESH_TOKEN_PATH = path.join(WORKSPACE_DIR, '.docker-infra', '.git-refresh-token');

function sanitizeGitConfigValue(value) {
  return typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim() : '';
}

async function refreshGitCredentials() {
  try {
    const refreshToken = (await fs.readFile(GIT_REFRESH_TOKEN_PATH, 'utf8')).trim();
    if (!refreshToken) return false;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(PHANTOMWP_URL + '/api/local/git-token', {
      headers: { 'Authorization': 'Bearer ' + refreshToken },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error('Git token refresh failed: HTTP ' + res.status);
      return false;
    }

    const data = await res.json();
    if (!data.success || !data.token) return false;

    const authorName = sanitizeGitConfigValue(data.authorName);
    const authorEmail = sanitizeGitConfigValue(data.authorEmail);
    if (authorName) await runGitCommand(['config', 'user.name', authorName]);
    if (authorEmail && /^[^@\s]+@[^@\s]+$/.test(authorEmail)) {
      await runGitCommand(['config', 'user.email', authorEmail]);
    }

    const username = (data.username || 'git').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeToken = data.token.replace(/[\s\r\n]/g, '');
    const credLine = 'https://' + username + ':' + safeToken + '@github.com\n';
    await fs.writeFile(GIT_CRED_PATH, credLine, { mode: 0o600 });

    if (data.repoUrl && typeof data.repoUrl === 'string') {
      if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(data.repoUrl)) {
        console.error('Invalid repo URL format, skipping remote setup');
      } else {
        try {
          await runGitCommand(['remote', 'get-url', 'origin']);
        } catch {
          await runGitCommand(['remote', 'add', 'origin', data.repoUrl]);
          console.log('Git remote origin set to ' + data.repoUrl);
        }
      }
    }

    await runGitCommand(['config', 'credential.helper', 'store --file=' + GIT_CRED_PATH]);
    console.log('Git credentials refreshed');
    return true;
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Git credential refresh error:', error.message);
    }
    return false;
  }
}

function isGitAuthError(errorMsg) {
  if (!errorMsg) return false;
  const lower = errorMsg.toLowerCase();
  return lower.includes('authentication') ||
    lower.includes('could not read username') ||
    lower.includes('invalid credentials') ||
    lower.includes('permission denied') ||
    lower.includes('403') ||
    lower.includes('401') ||
    lower.includes('fatal: repository') && lower.includes('not found');
}

async function runGitCommand(args, options = {}) {
  return execFileAsync('git', args, {
    cwd: WORKSPACE_DIR,
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
    ...options,
  });
}

// PhantomWP-managed entries that should always be in .gitignore. These are
// runtime / build caches that get regenerated locally and otherwise pollute
// the dirty-tree check (e.g. Astro content collections write to .astro/ on
// every dev server boot, which blocks branch switches until committed).
const MANAGED_GITIGNORE_ENTRIES = ['.astro/', '.cache/', '.turbo/', '.docker-infra/', '.jwt-public-key'];
let gitignoreMigrationChecked = false;

async function ensureManagedGitignore() {
  // Run at most once per connection lifetime.
  if (gitignoreMigrationChecked) return false;
  gitignoreMigrationChecked = true;

  try {
    // Skip when not in a git repo at all (handler will error out separately).
    try {
      await fs.access(path.join(WORKSPACE_DIR, '.git'));
    } catch {
      return false;
    }

    // Skip during rebase / merge / cherry-pick so we don't pollute partial state.
    for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
      try {
        await fs.access(path.join(WORKSPACE_DIR, '.git', marker));
        return false;
      } catch { /* not present, good */ }
    }
    try {
      await runGitCommand(['symbolic-ref', '--quiet', 'HEAD']);
    } catch {
      return false; // Detached HEAD.
    }

    const gitignorePath = path.join(WORKSPACE_DIR, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch { /* file may not exist yet */ }

    const existing = new Set(
      content.split('\n').map(line => line.trim()).filter(Boolean)
    );
    const missing = MANAGED_GITIGNORE_ENTRIES.filter(entry => {
      const stem = entry.replace(/\/$/, '');
      return !existing.has(entry) && !existing.has(stem);
    });
    if (missing.length === 0) return false;

    const prefix = content === '' || content.endsWith('\n') ? content : content + '\n';
    const block = '\n# PhantomWP: build cache (auto-managed)\n' + missing.join('\n') + '\n';
    await fs.writeFile(gitignorePath, prefix + block);

    // Commit only the .gitignore change so it doesn't show up as dirty next
    // time we run git status (which would defeat the whole point). Path-scoped
    // commit so any other staged/unstaged work is left alone.
    try {
      await runGitCommand(['add', '.gitignore']);
      await runGitCommand([
        'commit',
        '-m', 'chore: ignore build cache (auto-managed by PhantomWP)',
        '--', '.gitignore',
      ]);
      console.log('🔀 Auto-added to .gitignore: ' + missing.join(', '));
      return true;
    } catch (commitErr) {
      // If the commit fails (e.g. user.name/user.email not configured, or
      // pre-commit hook rejects), leave the .gitignore on disk — it will
      // show as a dirty file the user can commit themselves.
      console.log('⚠️  Could not auto-commit .gitignore: ' + commitErr.message);
      return false;
    }
  } catch (err) {
    console.log('⚠️  ensureManagedGitignore failed: ' + err.message);
    return false;
  }
}

// List files in a directory (recursive)
async function listDirectory(dirPath, basePath = '') {
  const files = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const allowedHiddenRootEntries = new Set(['.astro', '.devcontainer', '.claude', '.phantomwp']);
    
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !allowedHiddenRootEntries.has(entry.name)) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      
      const relativePath = basePath ? basePath + '/' + entry.name : entry.name;
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        files.push({
          name: entry.name,
          path: relativePath,
          isDirectory: true,
        });
        const subFiles = await listDirectory(fullPath, relativePath);
        files.push(...subFiles);
      } else {
        files.push({
          name: entry.name,
          path: relativePath,
          isDirectory: false,
        });
      }
    }
  } catch (error) {
    console.error('Error listing directory ' + dirPath + ':', error.message);
  }
  return files;
}

// Handle client connection
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log('🔌 New connection from ' + clientIp);
  
  // Authenticate on connection via URL token
  const authData = authenticateConnection(req);
  
  if (!authData) {
    console.error('❌ Unauthorized connection attempt from ' + clientIp);
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  // Store auth data on connection
  ws.userId = authData.userId;
  ws.username = authData.username;
  ws.repoId = authData.repoId;
  ws.repoName = authData.repoName;
  
  console.log('✅ Client connected: ' + authData.username + ' (' + authData.repoName + ')');

  // Connection health
  let isAlive = true;
  
  ws.on('ping', () => { ws.pong(); });
  ws.on('pong', () => { isAlive = true; });

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, 20000);

  ws.on('message', async (message) => {
    try {
      const messageStr = typeof message === 'string' ? message : message.toString('utf8');
      const data = JSON.parse(messageStr);
      const username = ws.username || 'unknown';

      if (!checkRateLimit(ws)) {
        sendWsResponse(ws, data, { action: 'error', error: 'Rate limit exceeded', success: false });
        return;
      }
      
      // Handle ping action
      if (data.action === 'ping') {
        sendWsResponse(ws, data, { action: 'pong' });
        return;
      }

      // Handle IDE command responses (request/response pattern)
      if (data.action === 'ide-response' && data._requestId) {
        const pending = pendingResponses.get(data._requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingResponses.delete(data._requestId);
          pending.res.writeHead(200, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ success: true, data: data.data || null }));
        }
        return;
      }
      
      // Validate path
      if (data.path && !isPathSafe(data.path)) {
        sendWsResponse(ws, data, {
          action: data.action,
          path: data.path,
          error: 'Invalid file path',
          success: false,
        });
        console.error('❌ Path traversal attempt blocked: ' + data.path + ' (user: ' + username + ')');
        return;
      }
      
      // Handle file operations (using 'action' protocol)
      switch (data.action) {
        case 'read':
          try {
            const resolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, data.path);
            let content;
            if (data.encoding === 'base64') {
              const buffer = await fs.readFile(resolvedPath);
              content = buffer.toString('base64');
            } else {
              content = await fs.readFile(resolvedPath, 'utf8');
            }
            sendWsResponse(ws, data, {
              action: 'read',
              path: data.path,
              content,
              encoding: data.encoding || 'utf8',
              success: true,
            });
            console.log('📖 [' + username + '] Read file: ' + data.path + (data.encoding === 'base64' ? ' (base64)' : ''));
          } catch (error) {
            sendWsResponse(ws, data, {
              action: 'read',
              path: data.path,
              success: false,
              error: error.message,
            });
          }
          break;

        case 'write':
          try {
            const resolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, data.path);
            const dirname = path.dirname(resolvedPath);
            await fs.mkdir(dirname, { recursive: true });
            
            if (data.encoding === 'base64') {
              const buffer = Buffer.from(data.content, 'base64');
              await fs.writeFile(resolvedPath, buffer);
            } else {
              await fs.writeFile(resolvedPath, data.content, 'utf8');
            }

            sendWsResponse(ws, data, {
              action: 'write',
              path: data.path,
              success: true,
            });
            console.log('💾 [' + username + '] Wrote file: ' + data.path);
          } catch (error) {
            sendWsResponse(ws, data, {
              action: 'write',
              path: data.path,
              success: false,
              error: error.message,
            });
          }
          break;

        case 'write-batch': {
          // Bulk-write helper used by features that need to drop many files at
          // once (skills install/import, snapshot import, Claude Design import).
          // One request, one response -- mirrors docker/ws-server.js so managed
          // Codespaces infra stays at parity with the local Docker runtime.
          const batchFiles = Array.isArray(data.files) ? data.files : [];
          if (batchFiles.length === 0) {
            sendWsResponse(ws, data, {
              action: 'write-batch',
              success: false,
              error: 'No files provided in batch.',
            });
            break;
          }
          if (batchFiles.length > 1000) {
            sendWsResponse(ws, data, {
              action: 'write-batch',
              success: false,
              error: 'Batch size ' + batchFiles.length + ' exceeds limit of 1000 files.',
            });
            break;
          }

          const batchResults = [];
          let batchFailed = 0;
          for (const file of batchFiles) {
            try {
              if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
                throw new Error('Each batch entry needs a string path and content.');
              }
              const resolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, file.path);
              await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
              if (file.encoding === 'base64') {
                await fs.writeFile(resolvedPath, Buffer.from(file.content, 'base64'));
              } else {
                await fs.writeFile(resolvedPath, file.content, 'utf8');
              }
              batchResults.push({ path: file.path, success: true });
            } catch (error) {
              batchFailed += 1;
              batchResults.push({
                path: (file && file.path) ? file.path : '(unknown)',
                success: false,
                error: error.message,
              });
            }
          }

          sendWsResponse(ws, data, {
            action: 'write-batch',
            success: batchFailed === 0,
            written: batchResults.length - batchFailed,
            failed: batchFailed,
            results: batchResults,
          });
          console.log('💾 [' + username + '] Wrote batch: ' + (batchResults.length - batchFailed) + '/' + batchResults.length + ' files');
          break;
        }

        case 'list':
          try {
            const listPath = data.path || '.';
            const targetPath = assertSafeWorkspacePath(WORKSPACE_DIR, listPath);
            const files = await listDirectory(targetPath, listPath === '.' ? '' : listPath);
            sendWsResponse(ws, data, {
              action: 'list',
              path: data.path,
              files,
              success: true,
            });
            console.log('📂 [' + username + '] Listed directory: ' + data.path);
          } catch (error) {
            sendWsResponse(ws, data, {
              action: 'list',
              path: data.path,
              success: false,
              error: error.message,
            });
          }
          break;

        case 'delete':
          try {
            const resolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, data.path);
            const stats = await fs.stat(resolvedPath);
            if (stats.isDirectory()) {
              await fs.rm(resolvedPath, { recursive: true, force: true });
            } else {
              await fs.unlink(resolvedPath);
            }
            sendWsResponse(ws, data, {
              action: 'delete',
              path: data.path,
              success: true,
            });
            console.log('🗑️ [' + username + '] Deleted: ' + data.path);
          } catch (error) {
            sendWsResponse(ws, data, {
              action: 'delete',
              path: data.path,
              success: false,
              error: error.message,
            });
          }
          break;

        case 'rename':
          try {
            if (!data.oldPath || !data.newPath) {
              throw new Error('oldPath and newPath are required');
            }
            const oldResolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, data.oldPath);
            const newResolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, data.newPath);
            const newDir = path.dirname(newResolvedPath);
            await fs.mkdir(newDir, { recursive: true });
            await fs.rename(oldResolvedPath, newResolvedPath);
            sendWsResponse(ws, data, {
              action: 'rename',
              oldPath: data.oldPath,
              newPath: data.newPath,
              success: true,
            });
            console.log('📝 [' + username + '] Renamed: ' + data.oldPath + ' → ' + data.newPath);
          } catch (error) {
            sendWsResponse(ws, data, {
              action: 'rename',
              oldPath: data.oldPath,
              newPath: data.newPath,
              success: false,
              error: error.message,
            });
          }
          break;

        case 'create':
          try {
            const resolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, data.path);
            const dirname = path.dirname(resolvedPath);
            await fs.mkdir(dirname, { recursive: true });
            await fs.writeFile(resolvedPath, data.content || '', { encoding: 'utf8', flag: 'wx' });

            sendWsResponse(ws, data, {
              action: 'create',
              path: data.path,
              success: true,
            });
            console.log('✨ [' + username + '] Created file: ' + data.path);
          } catch (error) {
            sendWsResponse(ws, data, {
              action: 'create',
              path: data.path,
              success: false,
              error: error.message,
            });
          }
          break;

        case 'mkdir':
          try {
            const resolvedPath = assertSafeWorkspacePath(WORKSPACE_DIR, data.path);
            await fs.mkdir(resolvedPath, { recursive: true });
            sendWsResponse(ws, data, {
              action: 'mkdir',
              path: data.path,
              success: true,
            });
            console.log('📁 [' + username + '] Created directory: ' + data.path);
          } catch (error) {
            sendWsResponse(ws, data, {
              action: 'mkdir',
              path: data.path,
              success: false,
              error: error.message,
            });
          }
          break;

        case 'git':
          try {
            const { command } = data;
            const allowedCommands = ['status', 'diff', 'log', 'branch', 'show', 'tag', 'add', 'commit', 'reset', 'push', 'pull', 'fetch', 'checkout', 'stash'];
            let gitArgs;
            if (Array.isArray(data.args)) {
              gitArgs = data.args.map(a => String(a));
            } else {
              gitArgs = tokenizeCommand(command || '');
            }
            const gitCommand = gitArgs[0];
            if (!allowedCommands.includes(gitCommand)) {
              throw new Error('Git command not allowed: ' + gitCommand);
            }
            const dangerousFlags = ['--exec', '--upload-pack', '--receive-pack', '-c', '--config', '--work-tree', '--git-dir', '--output'];
            for (const arg of gitArgs.slice(1)) {
              const lower = String(arg).toLowerCase();
              if (dangerousFlags.some(f => lower === f || lower.startsWith(f + '='))) {
                throw new Error('Git flag not allowed: ' + arg);
              }
            }
            const networkCommands = ['push', 'pull'];
            if (networkCommands.includes(gitCommand)) {
              const remoteName = gitArgs[1];
              if (remoteName && remoteName !== 'origin') {
                throw new Error('Only the "origin" remote is allowed for ' + gitCommand);
              }
            }
            const { stdout, stderr } = await runGitCommand(gitArgs);
            ws.send(JSON.stringify({
              action: 'git',
              success: true,
              stdout,
              stderr,
            }));
            console.log('🔀 [' + username + '] Git: ' + (command || gitArgs.join(' ')));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'gitStatus':
          try {
            const { stdout } = await runGitCommand(['status', '--porcelain']);
            const changes = stdout.trim().split('\n').filter(line => line.length > 0);
            ws.send(JSON.stringify({
              action: 'gitStatus',
              success: true,
              changes: changes.length,
              files: changes,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'gitStatus',
              success: true,
              changes: 0,
              files: [],
            }));
          }
          break;

        case 'git-status':
          try {
            await ensureManagedGitignore();
            const { stdout: statusOutput } = await runGitCommand(['status', '--porcelain']);
            const statusLines = statusOutput.trim().split('\n').filter(line => line.length > 0);
            const parsedChanges = statusLines.map(line => {
              const status = line.substring(0, 2);
              const file = line.substring(3);
              let type = 'modified';
              if (status.includes('?')) type = 'untracked';
              else if (status.includes('A')) type = 'added';
              else if (status.includes('D')) type = 'deleted';
              else if (status.includes('R')) type = 'renamed';
              else if (status.includes('M')) type = 'modified';
              return { file, status, type };
            });
            ws.send(JSON.stringify({
              action: 'git-status',
              success: true,
              changes: parsedChanges,
            }));
            console.log('🔀 [' + username + '] Git status: ' + parsedChanges.length + ' changes');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-status',
              success: false,
              error: error.message,
              changes: [],
            }));
          }
          break;

        case 'git-diff':
          try {
            const { file: diffFile } = data;
            if (!diffFile) {
              throw new Error('File path is required for git-diff');
            }
            const resolvedDiffPath = assertSafeWorkspacePath(WORKSPACE_DIR, diffFile);
            const relativeDiffPath = path.relative(WORKSPACE_DIR, resolvedDiffPath) || '.';
            const { stdout: diffOutput } = await runGitCommand(['diff', '--', relativeDiffPath]);
            ws.send(JSON.stringify({
              action: 'git-diff',
              success: true,
              file: diffFile,
              diff: diffOutput,
            }));
            console.log('🔀 [' + username + '] Git diff: ' + diffFile);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-diff',
              success: false,
              error: error.message,
              diff: '',
            }));
          }
          break;

        case 'git-commit':
          try {
            const { message: commitMsg } = data;
            if (!commitMsg) {
              throw new Error('Commit message is required');
            }
            await refreshGitCredentials();
            // First, stage all changes
            await runGitCommand(['add', '-A']);
            // Then commit with the message
            const { stdout: commitOutput } = await runGitCommand(['commit', '-m', commitMsg]);
            ws.send(JSON.stringify({
              action: 'git-commit',
              success: true,
              message: commitMsg,
              output: commitOutput,
            }));
            console.log('🔀 [' + username + '] Git commit: ' + commitMsg);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-commit',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-push':
          try {
            await refreshGitCredentials();

            const { stdout: branchOut } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
            const currentBranch = branchOut.trim();
            let pushArgs = ['push'];
            let rebaseTarget = '@{u}';
            try {
              await runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
            } catch {
              rebaseTarget = 'origin/' + currentBranch;
              pushArgs = ['push', '-u', 'origin', currentBranch];
            }

            await runGitCommand(['fetch', 'origin'], { timeout: 60000 });
            try {
              const { stdout: divergeOut } = await runGitCommand(['rev-list', '--left-right', '--count', rebaseTarget + '...HEAD']);
              const [behindRaw] = divergeOut.trim().split(/\s+/);
              const behind = Number(behindRaw || '0');
              if (behind > 0) {
                if (rebaseTarget === '@{u}') {
                  await runGitCommand(['pull', '--rebase', '--autostash'], { timeout: 120000 });
                } else {
                  await runGitCommand(['rebase', '--autostash', rebaseTarget], { timeout: 120000 });
                }
              }
            } catch (error) {
              if (rebaseTarget === '@{u}' || !String(error.message).includes('unknown revision')) {
                throw error;
              }
            }

            const { stdout: pushOutput, stderr: pushStderr } = await runGitCommand(pushArgs, { timeout: 60000 });
            ws.send(JSON.stringify({
              action: 'git-push',
              success: true,
              output: pushOutput || pushStderr,
            }));
            console.log('🔀 [' + username + '] Git push completed');
          } catch (error) {
            const authFailed = isGitAuthError(error.message);
            let rebaseConflict = false;
            try {
              await fs.access(path.join(WORKSPACE_DIR, '.git', 'rebase-merge'));
              rebaseConflict = true;
            } catch { /* not in conflict */ }
            if (!rebaseConflict) {
              try {
                await fs.access(path.join(WORKSPACE_DIR, '.git', 'rebase-apply'));
                rebaseConflict = true;
              } catch { /* not in conflict */ }
            }
            ws.send(JSON.stringify({
              action: 'git-push',
              success: false,
              error: error.message,
              authError: authFailed,
              rebaseConflict,
            }));
          }
          break;

        case 'git-pull-force':
          try {
            await refreshGitCredentials();
            await runGitCommand(['fetch', 'origin'], { timeout: 60000 });
            const { stdout: branchOutput } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
            const currentBranch = branchOutput.trim();
            if (!/^[a-zA-Z0-9/_.-]+$/.test(currentBranch)) {
              throw new Error('Invalid branch name');
            }
            const { stdout: resetOutput, stderr: resetStderr } = await runGitCommand(['reset', '--hard', 'origin/' + currentBranch]);
            ws.send(JSON.stringify({
              action: 'git-pull-force',
              success: true,
              branch: currentBranch,
              output: resetOutput || resetStderr,
            }));
            console.log('🔀 [' + username + '] Git pull force completed (branch: ' + currentBranch + ')');
          } catch (error) {
            const authFailed = isGitAuthError(error.message);
            ws.send(JSON.stringify({
              action: 'git-pull-force',
              success: false,
              error: error.message,
              authError: authFailed,
            }));
          }
          break;

        case 'git-branches':
          try {
            await refreshGitCredentials().catch(() => { /* best-effort */ });
            try { await runGitCommand(['fetch', '--prune', 'origin'], { timeout: 60000 }); } catch { /* offline ok */ }

            const { stdout: currentOut } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
            const currentBranch = currentOut.trim();

            let defaultBranch = '';
            try {
              const { stdout: defOut } = await runGitCommand(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
              defaultBranch = defOut.trim().replace(/^origin\//, '');
            } catch {
              try {
                const { stdout: remoteShow } = await runGitCommand(['remote', 'show', 'origin']);
                const match = remoteShow.match(/HEAD branch:\s*(\S+)/);
                if (match) defaultBranch = match[1];
              } catch { /* leave empty */ }
            }
            if (!defaultBranch) defaultBranch = 'main';

            const { stdout: localOut } = await runGitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
            const localBranches = localOut.split('\n').map(b => b.trim()).filter(Boolean);
            const localBranchSet = new Set(localBranches);

            let remoteBranches = [];
            try {
              const { stdout: remoteOut } = await runGitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/']);
              remoteBranches = remoteOut.split('\n')
                .map(b => b.trim())
                .filter(Boolean)
                .filter(b => !b.endsWith('/HEAD'))
                .map(b => b.replace(/^origin\//, ''));
            } catch { /* no remote tracking yet */ }
            const remoteBranchSet = new Set(remoteBranches);

            const branchRefFor = (branchName) => {
              if (localBranchSet.has(branchName)) return branchName;
              if (remoteBranchSet.has(branchName)) return 'origin/' + branchName;
              return '';
            };
            const defaultRef = remoteBranchSet.has(defaultBranch)
              ? 'origin/' + defaultBranch
              : branchRefFor(defaultBranch) || defaultBranch;
            const allBranches = Array.from(new Set([...localBranches, ...remoteBranches]));
            const branchSummaries = [];
            for (const branchName of allBranches.slice(0, 40)) {
              if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branchName)) continue;
              const branchRef = branchRefFor(branchName);
              if (!branchRef) continue;

              let commitsToPublish = 0;
              let commitsBehindProduction = 0;
              let recentCommits = [];
              let changedFiles = [];
              try {
                const { stdout: countOut } = await runGitCommand(['rev-list', '--left-right', '--count', defaultRef + '...' + branchRef]);
                const [behindRaw, aheadRaw] = countOut.trim().split(/\s+/);
                commitsBehindProduction = Number(behindRaw || '0') || 0;
                commitsToPublish = Number(aheadRaw || '0') || 0;
              } catch { /* branch comparison unavailable */ }

              if (branchName !== defaultBranch && commitsToPublish > 0) {
                try {
                  const { stdout: logOut } = await runGitCommand(['log', '--format=%s', '--max-count=4', defaultRef + '..' + branchRef]);
                  recentCommits = logOut.split('\n').map(line => line.trim()).filter(Boolean);
                } catch { /* ignore */ }
                try {
                  const { stdout: filesOut } = await runGitCommand(['diff', '--name-status', defaultRef + '...' + branchRef]);
                  changedFiles = filesOut.split('\n')
                    .map(line => line.trim())
                    .filter(Boolean)
                    .slice(0, 12)
                    .map(line => {
                      const [status, ...fileParts] = line.split(/\s+/);
                      return { status, file: fileParts.join(' ') };
                    });
                } catch { /* ignore */ }
              }

              branchSummaries.push({
                name: branchName,
                isDefault: branchName === defaultBranch,
                isCurrent: branchName === currentBranch,
                isLocal: localBranchSet.has(branchName),
                isRemote: remoteBranchSet.has(branchName),
                commitsToPublish,
                commitsBehindProduction,
                recentCommits,
                changedFiles,
              });
            }

            ws.send(JSON.stringify({
              action: 'git-branches',
              success: true,
              currentBranch,
              defaultBranch,
              localBranches,
              remoteBranches,
              branchSummaries,
            }));
            console.log('🔀 [' + username + '] Git branches listed (current: ' + currentBranch + ')');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-branches',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-branch-create':
          try {
            const rawName = (data.branch || '').trim();
            if (!rawName) throw new Error('Branch name is required');
            if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(rawName)) {
              throw new Error('Invalid branch name. Use letters, numbers, dashes, underscores, dots, or slashes.');
            }
            if (rawName.endsWith('.lock') || rawName.includes('..') || rawName.includes('//')) {
              throw new Error('Invalid branch name.');
            }

            const fromBranch = (data.from || '').trim();
            const createArgs = ['checkout', '-b', rawName];
            if (fromBranch && /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(fromBranch)) {
              createArgs.push(fromBranch);
            }

            await runGitCommand(createArgs);
            ws.send(JSON.stringify({
              action: 'git-branch-create',
              success: true,
              branch: rawName,
            }));
            console.log('🔀 [' + username + '] Git branch created: ' + rawName);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-branch-create',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-branch-checkout':
          try {
            const targetBranch = (data.branch || '').trim();
            const discardLocal = !!data.discardLocal;
            if (!targetBranch) throw new Error('Branch name is required');
            if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(targetBranch)) {
              throw new Error('Invalid branch name.');
            }

            await ensureManagedGitignore();
            const { stdout: statusOut } = await runGitCommand(['status', '--porcelain']);
            const dirtyLines = statusOut.trim().split('\n').filter(line => line.length > 0);
            if (dirtyLines.length > 0 && !discardLocal) {
              ws.send(JSON.stringify({
                action: 'git-branch-checkout',
                success: false,
                dirty: true,
                branch: targetBranch,
                dirtyFiles: dirtyLines.map(l => l.substring(3)).slice(0, 50),
                error: 'You have uncommitted changes. Commit, stash, or discard them before switching.',
              }));
              break;
            }

            if (discardLocal && dirtyLines.length > 0) {
              await runGitCommand(['reset', '--hard', 'HEAD']);
              await runGitCommand(['clean', '-fd']);
            }

            const { stdout: localList } = await runGitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
            const localBranchSet = new Set(localList.split('\n').map(b => b.trim()).filter(Boolean));

            if (localBranchSet.has(targetBranch)) {
              await runGitCommand(['checkout', targetBranch]);
            } else {
              await runGitCommand(['checkout', '-b', targetBranch, '--track', 'origin/' + targetBranch]);
            }

            ws.send(JSON.stringify({
              action: 'git-branch-checkout',
              success: true,
              branch: targetBranch,
              discarded: discardLocal,
            }));
            console.log('🔀 [' + username + '] Git checkout: ' + targetBranch + (discardLocal ? ' (discarded local)' : ''));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-branch-checkout',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-abort-rebase':
          try {
            let rebaseActive = false;
            try {
              await fs.access(path.join(WORKSPACE_DIR, '.git', 'rebase-merge'));
              rebaseActive = true;
            } catch { /* not active */ }
            if (!rebaseActive) {
              try {
                await fs.access(path.join(WORKSPACE_DIR, '.git', 'rebase-apply'));
                rebaseActive = true;
              } catch { /* not active */ }
            }
            if (!rebaseActive) {
              ws.send(JSON.stringify({
                action: 'git-abort-rebase',
                success: true,
                wasActive: false,
              }));
              break;
            }
            await runGitCommand(['rebase', '--abort']);
            ws.send(JSON.stringify({
              action: 'git-abort-rebase',
              success: true,
              wasActive: true,
            }));
            console.log('🔀 [' + username + '] Git rebase aborted');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-abort-rebase',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-merge-into':
          try {
            const targetBranch = (data.targetBranch || '').trim();
            const deleteSource = !!data.deleteSource;
            if (!targetBranch) throw new Error('Target branch is required');
            if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(targetBranch)) {
              throw new Error('Invalid target branch name.');
            }

            const { stdout: headOut } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
            const sourceBranch = headOut.trim();
            if (!sourceBranch || sourceBranch === 'HEAD') {
              throw new Error('Detached HEAD - cannot merge from no branch.');
            }
            if (sourceBranch === targetBranch) {
              throw new Error('Cannot merge a branch into itself.');
            }

            await ensureManagedGitignore();
            const { stdout: statusOut } = await runGitCommand(['status', '--porcelain']);
            const dirtyLines = statusOut.trim().split('\n').filter(line => line.length > 0);
            if (dirtyLines.length > 0) {
              ws.send(JSON.stringify({
                action: 'git-merge-into',
                success: false,
                dirty: true,
                sourceBranch,
                targetBranch,
                dirtyFiles: dirtyLines.map(l => l.substring(3)).slice(0, 50),
                error: 'You have uncommitted changes. Commit them on ' + sourceBranch + ' before merging.',
              }));
              break;
            }

            await refreshGitCredentials();
            try { await runGitCommand(['fetch', 'origin'], { timeout: 60000 }); } catch { /* offline ok */ }

            try {
              const { stdout: aheadOut } = await runGitCommand(['rev-list', '--count', 'origin/' + sourceBranch + '..HEAD']);
              if (parseInt(aheadOut.trim(), 10) > 0) {
                await runGitCommand(['push', '-u', 'origin', sourceBranch], { timeout: 60000 });
              }
            } catch {
              try { await runGitCommand(['push', '-u', 'origin', sourceBranch], { timeout: 60000 }); } catch { /* will surface on merge push */ }
            }

            await runGitCommand(['checkout', targetBranch]);
            try {
              await runGitCommand(['pull', '--ff-only', 'origin', targetBranch], { timeout: 60000 });
            } catch (pullErr) {
              await runGitCommand(['checkout', sourceBranch]).catch(() => {});
              throw new Error('Could not fast-forward ' + targetBranch + ' from origin. Resolve the divergence on GitHub first. (' + pullErr.message + ')');
            }

            let mergeFailed = false;
            try {
              await runGitCommand(['merge', '--no-ff', '-m', "Merge branch '" + sourceBranch + "' into " + targetBranch, sourceBranch]);
            } catch {
              mergeFailed = true;
            }

            if (mergeFailed) {
              let conflictFiles = [];
              try {
                const { stdout: conflictOut } = await runGitCommand(['diff', '--name-only', '--diff-filter=U']);
                conflictFiles = conflictOut.split('\n').map(f => f.trim()).filter(Boolean);
              } catch { /* best effort */ }
              await runGitCommand(['merge', '--abort']).catch(() => {});
              await runGitCommand(['checkout', sourceBranch]).catch(() => {});
              ws.send(JSON.stringify({
                action: 'git-merge-into',
                success: false,
                conflict: true,
                sourceBranch,
                targetBranch,
                conflictFiles,
                error: 'Merge conflicts in ' + conflictFiles.length + ' file(s). Nothing was pushed.',
              }));
              break;
            }

            try {
              await runGitCommand(['push', 'origin', targetBranch], { timeout: 60000 });
            } catch (pushErr) {
              const authFailed = isGitAuthError(pushErr.message);
              // Roll back to the source branch so a failed push doesn't strand the
              // user on the target branch with a local-only merge commit (mirrors
              // the conflict path above).
              await runGitCommand(['checkout', sourceBranch]).catch(() => {});
              ws.send(JSON.stringify({
                action: 'git-merge-into',
                success: false,
                pushFailed: true,
                sourceBranch,
                targetBranch,
                authError: authFailed,
                error: pushErr.message,
              }));
              break;
            }

            let deletedSource = false;
            if (deleteSource) {
              try {
                await runGitCommand(['branch', '-d', sourceBranch]);
                try { await runGitCommand(['push', 'origin', '--delete', sourceBranch], { timeout: 60000 }); } catch { /* remote may not exist */ }
                deletedSource = true;
              } catch { /* keep branch if unmerged */ }
            }

            const finalBranch = deletedSource ? targetBranch : sourceBranch;
            if (!deletedSource) {
              await runGitCommand(['checkout', sourceBranch]).catch(() => {});
            }

            ws.send(JSON.stringify({
              action: 'git-merge-into',
              success: true,
              sourceBranch,
              targetBranch,
              deletedSource,
              finalBranch,
            }));
            console.log('🔀 [' + username + '] Git merged ' + sourceBranch + ' into ' + targetBranch + (deletedSource ? ' (deleted source)' : ''));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-merge-into',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-delete-branch':
          try {
            const branchToDelete = (data.branch || '').trim();
            const force = !!data.force;
            const deleteRemote = !!data.deleteRemote;
            if (!branchToDelete) throw new Error('Branch name is required');
            if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branchToDelete)) {
              throw new Error('Invalid branch name.');
            }

            const { stdout: headOut } = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
            const currentHead = headOut.trim();
            if (currentHead === branchToDelete) {
              throw new Error('Cannot delete the current branch. Switch to another branch first.');
            }

            let defaultBranch = '';
            try {
              const { stdout: defOut } = await runGitCommand(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
              defaultBranch = defOut.trim().replace(/^origin\//, '');
            } catch { /* ignore */ }
            if (defaultBranch && branchToDelete === defaultBranch) {
              throw new Error('Refusing to delete the default branch.');
            }

            let localExists = false;
            try {
              await runGitCommand(['show-ref', '--verify', '--quiet', 'refs/heads/' + branchToDelete]);
              localExists = true;
            } catch { /* local branch may not exist */ }

            let deletedLocal = false;
            if (localExists) {
              await runGitCommand(['branch', force ? '-D' : '-d', branchToDelete]);
              deletedLocal = true;
            }

            let deletedRemote = false;
            if (deleteRemote) {
              try {
                await refreshGitCredentials();
                await runGitCommand(['push', 'origin', '--delete', branchToDelete], { timeout: 60000 });
                deletedRemote = true;
              } catch (remoteError) {
                if (!deletedLocal) {
                  throw new Error('Branch was not found locally and could not be deleted on GitHub: ' + remoteError.message);
                }
              }
            }

            if (!deletedLocal && !deletedRemote) {
              throw new Error('Branch was not found locally or on GitHub.');
            }

            ws.send(JSON.stringify({
              action: 'git-delete-branch',
              success: true,
              branch: branchToDelete,
              deletedLocal,
              deletedRemote,
            }));
            console.log('🔀 [' + username + '] Git deleted branch ' + branchToDelete);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-delete-branch',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'exec': {
          let parsed;
          try {
            const { command: execCommand } = data;
            if (!execCommand) {
              throw new Error('Command is required');
            }
            parsed = parseExecCommand(execCommand);
            const { stdout: execOutput, stderr: execStderr } = await execFileAsync(parsed.bin, parsed.args, {
              cwd: WORKSPACE_DIR,
              timeout: parsed.timeoutMs,
              maxBuffer: 5 * 1024 * 1024,
            });
            sendWsResponse(ws, data, {
              action: 'exec',
              success: true,
              command: execCommand,
              output: execOutput || execStderr,
            });
            console.log('⚡ [' + username + '] Exec: ' + execCommand);
          } catch (error) {
            const isExecTimeout = error?.signal === 'SIGTERM' && error?.killed;
            const execErrMessage = isExecTimeout ? 'Command timed out after ' + parsed.timeoutMs + 'ms' : error.message;
            const execErrOutput = error.stdout || error.stderr || '';
            sendWsResponse(ws, data, {
              action: 'exec',
              success: false,
              command: data.command,
              error: execErrMessage,
              output: execErrOutput,
            });
            console.error('❌ [' + username + '] Exec failed: ' + error.message);
          }
          break;
        }

        case 'terminal-open': {
          try {
            const termId = data.id || 'default';
            
            // Kill existing session if any
            if (terminalSessions.has(termId)) {
              const old = terminalSessions.get(termId);
              try { old.kill(); } catch {}
              terminalSessions.delete(termId);
            }

            const cols = data.cols || 80;
            const rows = data.rows || 24;
            const cwd = process.cwd();
            const shell = process.env.SHELL || '/bin/bash';

            let ptyProcess;
            if (ptyModule) {
              // Full PTY with node-pty
              ptyProcess = ptyModule.spawn(shell, ['-l'], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd,
                env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
              });

              ptyProcess.onData((output) => {
                try {
                  ws.send(JSON.stringify({ action: 'terminal-output', id: termId, data: output }));
                } catch {}
              });

              ptyProcess.onExit(({ exitCode }) => {
                terminalSessions.delete(termId);
                try {
                  ws.send(JSON.stringify({ action: 'terminal-exit', id: termId, exitCode }));
                } catch {}
              });
            } else {
              // Fallback: basic shell without PTY
              const child = spawn(shell, ['-l'], {
                cwd,
                env: { ...process.env, TERM: 'xterm-256color' },
                stdio: ['pipe', 'pipe', 'pipe'],
              });

              // Wrap child to match pty interface
              ptyProcess = {
                write: (d) => child.stdin.write(d),
                resize: () => {},
                kill: () => child.kill(),
                pid: child.pid,
              };

              child.stdout.on('data', (output) => {
                try {
                  ws.send(JSON.stringify({ action: 'terminal-output', id: termId, data: output.toString() }));
                } catch {}
              });

              child.stderr.on('data', (output) => {
                try {
                  ws.send(JSON.stringify({ action: 'terminal-output', id: termId, data: output.toString() }));
                } catch {}
              });

              child.on('exit', (exitCode) => {
                terminalSessions.delete(termId);
                try {
                  ws.send(JSON.stringify({ action: 'terminal-exit', id: termId, exitCode }));
                } catch {}
              });
            }

            terminalSessions.set(termId, ptyProcess);
            ws.send(JSON.stringify({ action: 'terminal-open', id: termId, success: true, pid: ptyProcess.pid }));
            console.log('🖥️  [' + username + '] Terminal opened: ' + termId + ' (pid: ' + ptyProcess.pid + ')');
          } catch (error) {
            ws.send(JSON.stringify({ action: 'terminal-open', id: data.id || 'default', success: false, error: error.message }));
            console.error('❌ Terminal open failed:', error.message);
          }
          break;
        }

        case 'terminal-input': {
          const termId = data.id || 'default';
          const session = terminalSessions.get(termId);
          if (session && data.data) {
            session.write(data.data);
          }
          break;
        }

        case 'terminal-resize': {
          const termId = data.id || 'default';
          const session = terminalSessions.get(termId);
          if (session && data.cols && data.rows) {
            try { session.resize(data.cols, data.rows); } catch {}
          }
          break;
        }

        case 'terminal-close': {
          const termId = data.id || 'default';
          const session = terminalSessions.get(termId);
          if (session) {
            try { session.kill(); } catch {}
            terminalSessions.delete(termId);
            console.log('🖥️  [' + username + '] Terminal closed: ' + termId);
          }
          ws.send(JSON.stringify({ action: 'terminal-close', id: termId, success: true }));
          break;
        }

        case 'format': {
          try {
            const { content: fmtContent, filePath: fmtPath } = data;
            if (!fmtContent || !fmtPath) {
              throw new Error('content and filePath are required');
            }

            const { prettier: fmt, astroPlugin } = await loadPrettier();
            if (!fmt) {
              throw new Error('Prettier is not installed. Run: npm install prettier prettier-plugin-astro');
            }

            const ext = fmtPath.split('.').pop()?.toLowerCase();
            const options = {
              tabWidth: 4,
              useTabs: false,
              printWidth: 100,
              semi: true,
              singleQuote: true,
              trailingComma: 'es5',
            };

            let formatted;
            if (ext === 'astro' && astroPlugin) {
              formatted = await fmt.format(fmtContent, {
                ...options,
                parser: 'astro',
                plugins: [astroPlugin],
                htmlWhitespaceSensitivity: 'ignore',
              });
            } else if (ext === 'ts' || ext === 'tsx') {
              formatted = await fmt.format(fmtContent, { ...options, parser: 'typescript' });
            } else if (ext === 'js' || ext === 'jsx') {
              formatted = await fmt.format(fmtContent, { ...options, parser: 'babel' });
            } else if (ext === 'css' || ext === 'scss') {
              formatted = await fmt.format(fmtContent, { ...options, parser: 'css' });
            } else if (ext === 'json') {
              formatted = await fmt.format(fmtContent, { ...options, parser: 'json' });
            } else if (ext === 'html') {
              formatted = await fmt.format(fmtContent, { ...options, parser: 'html', htmlWhitespaceSensitivity: 'ignore' });
            } else if (ext === 'md' || ext === 'mdx') {
              formatted = await fmt.format(fmtContent, { ...options, parser: 'markdown' });
            } else {
              formatted = fmtContent;
            }

            ws.send(JSON.stringify({
              action: 'format',
              success: true,
              filePath: fmtPath,
              content: formatted,
            }));
            console.log('📝 [' + username + '] Formatted: ' + fmtPath);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'format',
              success: false,
              filePath: data.filePath,
              error: error.message,
            }));
            console.error('❌ [' + username + '] Format failed: ' + error.message);
          }
          break;
        }

        default:
          console.log('Unknown action: ' + data.action);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ action: 'error', error: error.message, success: false }));
    }
  });
  
  ws.on('close', () => {
    clearInterval(pingInterval);
    // Clean up terminal sessions for this connection
    for (const [id, session] of terminalSessions.entries()) {
      try { session.kill(); } catch {}
      terminalSessions.delete(id);
    }
    console.log('🔌 Client disconnected: ' + ws.username);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clearInterval(pingInterval);
  });
});

console.log('🔌 WebSocket server running on port ' + PORT);
console.log('🌐 IDE command bridge available at http://localhost:' + PORT + '/ide-command');
console.log('📁 Watching directory:', process.cwd());
