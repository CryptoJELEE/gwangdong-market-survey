import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, copyFile, stat } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { assignArea, assignAreaByDistance } from './assignment.js';
import { createGeocoder } from './geocoding.js';
import { SurveyStore } from './storage/index.js';
import { collectJsonBody } from './utils.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — for submissions/import (includes photos)
const MAX_AUTH_BODY_BYTES = 4 * 1024; // 4 KB — for login, change-password
const MAX_SETTINGS_BODY_BYTES = 256 * 1024; // 256 KB — for settings updates
const MAX_PHOTO_BYTES = 500 * 1024; // 500 KB
const COMPRESSION_THRESHOLD = 1024; // bytes — compress responses larger than this
const PAGINATION_MAX_LIMIT = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;  // 30s — normal requests
const UPLOAD_REQUEST_TIMEOUT_MS = 120_000;  // 2min — submission POST (includes photo upload)
const SLOW_REQUEST_THRESHOLD_MS = 2_000;    // warn on requests slower than 2s
const BACKUP_INTERVAL_MS = 24 * 60 * 60_000; // 24h periodic backup
const SERVER_STARTED_AT = new Date().toISOString();
const PKG_VERSION = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')).version;

// Structured logger with ISO timestamp — keeps log levels distinct for filtering/aggregation
const log = {
  info:  (...args) => console.log( `${new Date().toISOString()} [INFO] `, ...args),
  warn:  (...args) => console.warn( `${new Date().toISOString()} [WARN] `, ...args),
  error: (...args) => console.error(`${new Date().toISOString()} [ERROR]`, ...args)
};

/**
 * Validate the runtime configuration and log warnings for common misconfigurations.
 * Returns the list of warning strings (empty if all is well).
 *
 * @param {object} config  Loaded app config
 * @returns {string[]}     Warning messages
 */
function validateEnvironment(config) {
  const warnings = [];
  if (!config.adminPassword || config.adminPassword === 'ionroad2026') {
    warnings.push('ADMIN_PASSWORD is using the default value — change it in production');
  }
  if (config.googleSheets?.enabled) {
    if (!config.googleSheets.spreadsheetId) {
      warnings.push('GOOGLE_SHEETS_ENABLED=true but GOOGLE_SHEETS_SPREADSHEET_ID is not set');
    }
    if (!config.googleSheets.clientEmail) {
      warnings.push('GOOGLE_SHEETS_ENABLED=true but GOOGLE_SHEETS_CLIENT_EMAIL is not set');
    }
  }
  return warnings;
}

/**
 * Run a WAL checkpoint on the SQLite database (best-effort).
 * Accesses `store.localStore.db` — a better-sqlite3 Database handle.
 * Silently skips if the DB handle is not accessible (e.g., in tests with mocks).
 *
 * @param {object} store  SurveyStore instance
 */
function walCheckpoint(store) {
  try {
    const db = store?.localStore?.db;
    if (db && typeof db.pragma === 'function') {
      db.pragma('wal_checkpoint(TRUNCATE)');
      log.info('[DB] WAL checkpoint completed');
    }
  } catch (err) {
    log.warn('[DB] WAL checkpoint failed:', err.message);
  }
}

/**
 * Copy the SQLite DB file to a dated backup file.
 * Best-effort — never throws. Safe with WAL mode (default in better-sqlite3)
 * because the main db file is always page-consistent.
 *
 * @param {string} dbFile  Absolute path to the .db file
 */
async function backupDatabase(dbFile) {
  if (!dbFile) return;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const backupPath = `${dbFile}.${date}.bak`;
    await copyFile(dbFile, backupPath);
    // Copy WAL file too if it exists (needed for a truly consistent snapshot)
    try { await copyFile(`${dbFile}-wal`, `${backupPath}-wal`); } catch { /* no WAL */ }
    log.info(`[BACKUP] DB backup created: ${path.basename(backupPath)}`);
  } catch (err) {
    log.warn(`[BACKUP] DB backup failed: ${err.message}`);
  }
}

/**
 * POST a JSON webhook payload with up to `maxRetries` attempts.
 * Uses exponential backoff: 1s, 2s, 4s between retries.
 *
 * @param {string}   webhookUrl
 * @param {object}   payload
 * @param {Function} fetchFn      fetch-compatible function
 * @param {number}   [maxRetries=3]
 */
async function sendWebhookWithRetry(webhookUrl, payload, fetchFn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        if (attempt > 1) log.info(`[WEBHOOK] delivered after ${attempt} attempts`);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === maxRetries) {
        log.warn(`[WEBHOOK] failed after ${maxRetries} attempts: ${err.message}`);
        return;
      }
      const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s → 2s → 4s
      log.warn(`[WEBHOOK] attempt ${attempt} failed (${err.message}), retrying in ${backoffMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.isValidationError = true;
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'"
].join('; ');

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-XSS-Protection', '1; mode=block');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Content-Security-Policy', CSP);
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function filterSubmissionsByDate(submissions, targetDate) {
  // Use UTC date (first 10 chars of ISO string) to match how callers compute
  // the target date via new Date().toISOString().slice(0, 10).
  // Using local-time getDate() caused divergence around midnight in non-UTC zones.
  return submissions.filter((s) => s.createdAt?.slice(0, 10) === targetDate);
}

function buildAveragePrices(submissions) {
  const priceMap = {};
  for (const s of submissions) {
    if (!s.prices) continue;
    for (const p of s.prices) {
      const key = `${p.productLabel || p.productId}|${p.size}`;
      if (!priceMap[key]) priceMap[key] = { label: p.productLabel || p.productId, size: p.size, prices: [] };
      const num = Number(String(p.price).replace(/[^0-9]/g, ''));
      if (num > 0) priceMap[key].prices.push(num);
    }
  }
  return Object.values(priceMap)
    .filter((v) => v.prices.length > 0)
    .map((v) => ({
      label: v.label,
      size: v.size,
      avg: Math.round(v.prices.reduce((a, b) => a + b, 0) / v.prices.length),
      count: v.prices.length
    }));
}

/**
 * Serialise `payload` as JSON and write it to `response`.
 *
 * Envelope pattern: object payloads automatically receive a `success` boolean
 * (true for 2xx, false otherwise). Arrays are returned as-is to preserve
 * backward compatibility with clients that expect a plain array.
 *
 * Compression: gzip or deflate applied automatically when the payload exceeds
 * COMPRESSION_THRESHOLD and the client signals support via Accept-Encoding.
 * Saved bytes are logged at INFO level for monitoring.
 *
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse}  response
 * @param {number}               statusCode  HTTP status code to send
 * @param {unknown}              payload     Value to JSON-serialise
 */
async function sendJson(request, response, statusCode, payload) {
  // Envelope: inject success flag into object payloads only (not arrays)
  const enveloped = (payload !== null && typeof payload === 'object' && !Array.isArray(payload))
    ? { success: statusCode < 400, ...payload }
    : payload;

  const body = Buffer.from(JSON.stringify(enveloped));
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };

  if (body.length > COMPRESSION_THRESHOLD) {
    const acceptEncoding = request?.headers?.['accept-encoding'] || '';
    if (acceptEncoding.includes('gzip')) {
      const compressed = await new Promise((resolve, reject) =>
        zlib.gzip(body, (err, result) => (err ? reject(err) : resolve(result)))
      );
      const saved = body.length - compressed.length;
      log.info(`[GZIP] ${body.length}B → ${compressed.length}B (saved ${saved}B, ${Math.round(saved / body.length * 100)}%)`);
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = compressed.length;
      response.writeHead(statusCode, headers);
      response.end(compressed);
      return;
    } else if (acceptEncoding.includes('deflate')) {
      const compressed = await new Promise((resolve, reject) =>
        zlib.deflate(body, (err, result) => (err ? reject(err) : resolve(result)))
      );
      const saved = body.length - compressed.length;
      log.info(`[DEFLATE] ${body.length}B → ${compressed.length}B (saved ${saved}B, ${Math.round(saved / body.length * 100)}%)`);
      headers['Content-Encoding'] = 'deflate';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = compressed.length;
      response.writeHead(statusCode, headers);
      response.end(compressed);
      return;
    }
  }

  headers['Content-Length'] = body.length;
  response.writeHead(statusCode, headers);
  response.end(body);
}

// ── Password hashing (scrypt) ──
// Format: "scrypt$<hex-salt>$<hex-hash>" for hashed; plain text otherwise (backward compat)
const SCRYPT_KEYLEN = 32;
const SCRYPT_PREFIX = 'scrypt$';

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))))
  );
  return `${SCRYPT_PREFIX}${salt}$${hash}`;
}

/**
 * Verify a plaintext `provided` password against a `stored` value.
 * Supports two storage formats for backward compatibility:
 *   - Scrypt:    "scrypt$<hex-salt>$<hex-hash>"  (set by hashPassword)
 *   - Plaintext: any other string                 (env default / legacy)
 *
 * Both branches use timing-safe comparison to prevent timing attacks.
 *
 * @param {string} provided  Plaintext password from the request
 * @param {string} stored    Value from DB or config
 * @returns {Promise<boolean>}
 */
async function verifyPassword(provided, stored) {
  if (!stored || !stored.startsWith(SCRYPT_PREFIX)) {
    // Plain text stored (config default or legacy) — use timing-safe comparison
    return safeCompare(provided, stored);
  }
  const [, salt, expectedHex] = stored.split('$');
  const actualHex = await new Promise((resolve, reject) =>
    crypto.scrypt(provided, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))))
  );
  return safeCompare(actualHex, expectedHex);
}

// ── Rate Limiter ──
function createRateLimiter() {
  const buckets = new Map(); // key → { count, resetTime }
  const CLEANUP_INTERVAL = 60_000;

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetTime) buckets.delete(key);
    }
  }, CLEANUP_INTERVAL).unref();

  // Returns 0 when allowed; returns seconds-until-reset (≥1) when rate-limited.
  return function checkRate(key, maxRequests, windowMs = 60_000) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetTime) {
      bucket = { count: 0, resetTime: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count > maxRequests ? Math.max(1, Math.ceil((bucket.resetTime - now) / 1000)) : 0;
  };
}

function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.socket?.remoteAddress || 'unknown';
}

/**
 * Validate and normalise a raw submission body.
 * Throws a {@link ValidationError} (HTTP 400) on any constraint violation.
 *
 * Checks performed:
 *   - Required fields present (researcher name/area, store region/type/name)
 *   - Field length limits (name ≤50, storeName ≤100, region ≤200, notes ≤2000)
 *   - Photo size ≤ MAX_PHOTO_BYTES (estimated from base64 length)
 *   - Price values in range 0–999 999
 *
 * @param {object} body    Raw request body (already JSON-parsed)
 * @param {object} config  App config; must include `areas` array
 * @returns {{ researcher, survey, prices, photoDataUrl, notes }} Normalised payload
 */
function validateSubmission(body, config) {
  const required = [
    body.researcher?.name,
    body.researcher?.residenceArea,
    body.survey?.region,
    body.survey?.storeType,
    body.survey?.storeName
  ];
  if (required.some((item) => !item)) {
    throw new ValidationError('필수 제출 항목을 모두 입력해주세요.');
  }

  // Input length validation
  const researcherName = String(body.researcher.name).trim();
  const storeName = String(body.survey.storeName).trim();
  const region = String(body.survey.region).trim();
  const notes = String(body.notes || '').trim();

  if (researcherName.length > 50) throw new ValidationError('researcherName은 최대 50자입니다.');
  if (storeName.length > 100) throw new ValidationError('storeName은 최대 100자입니다.');
  if (region.length > 200) throw new ValidationError('region은 최대 200자입니다.');
  if (notes.length > 2000) throw new ValidationError('notes는 최대 2000자입니다.');

  // Photo size validation
  const photoDataUrl = String(body.photoDataUrl || '').trim();
  if (photoDataUrl.length > 0) {
    const base64Part = photoDataUrl.includes(',') ? photoDataUrl.split(',')[1] : photoDataUrl;
    const estimatedBytes = Math.ceil(base64Part.length * 3 / 4);
    if (estimatedBytes > MAX_PHOTO_BYTES) throw new ValidationError('사진은 최대 500KB입니다.');
  }

  const prices = (body.prices || []).filter((item) => item.price !== '' && item.price !== null && item.price !== undefined);

  // Price validation
  for (const item of prices) {
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 0 || price > 999999) {
      throw new ValidationError('가격은 0~999999 범위의 숫자여야 합니다.');
    }
  }

  return {
    researcher: {
      name: researcherName,
      residenceArea: config.areas.includes(body.researcher.residenceArea) ? body.researcher.residenceArea : config.areas[0]
    },
    survey: {
      region,
      storeType: String(body.survey.storeType).trim(),
      storeName,
      posCount: Number(body.survey.posCount || 0),
      displayLocation: String(body.survey.displayLocation || '').trim()
    },
    prices: prices.map((item) => ({
      productId: item.productId,
      productLabel: item.productLabel,
      size: item.size,
      price: Number(item.price)
    })),
    photoDataUrl,
    notes
  };
}

async function serveStatic(response, filePath, request) {
  const contents = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8'
  };

  // ETag + Cache-Control
  const etag = `"${crypto.createHash('md5').update(contents).digest('hex')}"`;

  // Respond 304 if client has a fresh copy
  if (request?.headers?.['if-none-match'] === etag) {
    response.writeHead(304);
    response.end();
    return;
  }

  const cacheHeaders = { 'Content-Type': contentTypes[extension] || 'application/octet-stream', 'ETag': etag };

  if (extension === '.html') {
    cacheHeaders['Cache-Control'] = 'no-cache';
  } else if (extension === '.css' || extension === '.js') {
    cacheHeaders['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=60';
  } else if (extension === '.json') {
    cacheHeaders['Cache-Control'] = 'public, max-age=600, must-revalidate';
  } else {
    cacheHeaders['Cache-Control'] = 'public, max-age=86400, immutable';
  }

  response.writeHead(200, cacheHeaders);
  response.end(contents);
}

function setCorsHeaders(response, allowedOrigin = '*') {
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  response.setHeader('Access-Control-Max-Age', '86400');
  if (allowedOrigin !== '*') {
    response.setHeader('Vary', 'Origin');
  }
}

export async function closeApp(server, { drainMs = 5000 } = {}) {
  if (!server) return;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
    // Close keep-alive connections immediately; in-flight requests get drainMs to finish
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), drainMs);
  });

  server._store?.close?.();
}

export function createApp(config = loadConfig(), options = {}) {
  const store = new SurveyStore(config);
  const geocoder = options.geocoder || createGeocoder({
    apiKey: config.kakaoRestApiKey,
    store,
    fetchImpl: options.fetchImpl || fetch
  });
  let initialized = false;
  let initPromise = null;

  // ── Admin IP whitelist (optional) ──
  // options.adminIpWhitelist: string[] | null — if set, admin endpoints reject non-listed IPs
  const adminIpWhitelist = options.adminIpWhitelist ?? null;

  function isAdminIpAllowed(ip) {
    if (!adminIpWhitelist || adminIpWhitelist.length === 0) return true;
    // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4)
    const normalised = ip.replace(/^::ffff:/, '');
    return adminIpWhitelist.includes(normalised) || adminIpWhitelist.includes(ip);
  }

  // ── Active connection counter (for /api/status) ──
  let activeConnections = 0;

  // ── Configurable CORS origins ──
  // options.allowedOrigins: string ('*'), single origin string, or array of origin strings
  const allowedOrigins = options.allowedOrigins ?? '*';

  function resolveOrigin(requestOrigin) {
    if (allowedOrigins === '*') return '*';
    const list = Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins];
    return (requestOrigin && list.includes(requestOrigin)) ? requestOrigin : list[0];
  }

  // ── Server metrics (in-memory, rolling window of last 1000 response times) ──
  const metrics = { requests: 0, errors: 0, responseTimes: [] };

  function recordMetric(statusCode, ms) {
    metrics.requests++;
    if (statusCode >= 500) metrics.errors++;
    metrics.responseTimes.push(ms);
    if (metrics.responseTimes.length > 1000) metrics.responseTimes.shift();
  }

  // ── Admin auth ──
  const adminTokens = new Map();
  const TOKEN_TTL = 24 * 60 * 60 * 1000;

  // Periodically purge stale tokens to prevent unbounded Map growth
  setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [token, createdAt] of adminTokens) {
      if (now - createdAt > TOKEN_TTL) { adminTokens.delete(token); removed++; }
    }
    if (removed > 0) log.info(`[TOKEN] purged ${removed} expired token(s)`);
  }, 60 * 60_000).unref(); // every hour

  function createAdminToken() {
    const token = crypto.randomUUID();
    adminTokens.set(token, Date.now());
    return token;
  }

  function checkAuth(request) {
    const auth = request.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const createdAt = adminTokens.get(token);
    if (createdAt === undefined) return false;
    if (Date.now() - createdAt > TOKEN_TTL) {
      adminTokens.delete(token);
      return false;
    }
    // Sliding window: each successful use resets the TTL
    adminTokens.set(token, Date.now());
    return true;
  }

  async function geocodeAreas(areas) {
    const areaCoordinates = await Promise.all(
      areas.map(async (area) => [area, await geocoder.tryGeocode(area)])
    );
    return areaCoordinates.reduce((accumulator, [area, coordinate]) => {
      if (coordinate) {
        accumulator[area] = coordinate;
      }
      return accumulator;
    }, {});
  }

  const checkRate = createRateLimiter();

  // ── Rate limit rules (endpoint-specific) ──
  // Returns 0 when allowed; returns Retry-After seconds (≥1) when blocked.
  function applyRateLimits(request, url, clientIp) {
    const method = request.method;
    const path = url.pathname;
    let retryAfter = 0;

    if (method === 'POST' && path === '/api/admin/login') {
      // Strict: 5 attempts per 15-minute window (brute-force protection)
      retryAfter = checkRate(`login:${clientIp}`, 5, 15 * 60_000);
      if (retryAfter) return retryAfter;
    } else if (method === 'POST' && path === '/api/submissions') {
      // 30 submissions per minute per IP
      retryAfter = checkRate(`submit:${clientIp}`, 30);
      if (retryAfter) return retryAfter;
    } else if (method === 'GET' && (path === '/api/geocode' || path === '/api/reverse-geocode')) {
      // 30 geocode requests per minute (external API cost)
      retryAfter = checkRate(`geocode:${clientIp}`, 30);
      if (retryAfter) return retryAfter;
    } else if (path.startsWith('/api/admin/')) {
      // 60 admin API calls per minute
      retryAfter = checkRate(`admin:${clientIp}`, 60);
      if (retryAfter) return retryAfter;
    }

    // Global fallback: 120 requests per minute across all endpoints
    return checkRate(`global:${clientIp}`, 120);
  }

  const server = http.createServer(async (request, response) => {
    const clientIp = getClientIp(request);
    const url = new URL(request.url, `http://${request.headers.host}`);
    const startMs = Date.now();
    const requestId = request.headers['x-request-id'] || crypto.randomUUID();

    // Propagate request ID to response for correlation
    response.setHeader('X-Request-Id', requestId);

    // Per-request timeout — uploads get extra time for photo data
    const timeoutMs = (request.method === 'POST' && url.pathname === '/api/submissions')
      ? UPLOAD_REQUEST_TIMEOUT_MS
      : DEFAULT_REQUEST_TIMEOUT_MS;
    request.setTimeout(timeoutMs, () => {
      log.warn(`[TIMEOUT] ${request.method} ${url.pathname} (${clientIp}) exceeded ${timeoutMs}ms`);
      if (!response.headersSent) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ success: false, error: '요청 처리 시간이 초과되었습니다.' }));
      } else {
        request.socket?.destroy();
      }
    });

    // Log response time, status, body size, and record metrics when response ends
    const originalEnd = response.end.bind(response);
    let logged = false;
    response.end = function(...args) {
      if (!logged) {
        logged = true;
        const ms = Date.now() - startMs;
        recordMetric(response.statusCode, ms);
        const bodyArg = args[0];
        const sizeBytes = bodyArg instanceof Buffer ? bodyArg.length
          : (typeof bodyArg === 'string' ? Buffer.byteLength(bodyArg) : 0);
        const logLine = `[${request.method}] ${url.pathname} ${response.statusCode} (${ms}ms, ${sizeBytes}B, ${clientIp}, ${requestId})`;
        if (ms > SLOW_REQUEST_THRESHOLD_MS) {
          log.warn(`[SLOW] ${logLine}`);
        } else {
          log.info(logLine);
        }
      }
      return originalEnd(...args);
    };

    setCorsHeaders(response, resolveOrigin(request.headers['origin']));
    setSecurityHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    // Rate limiting — adds Retry-After header so clients can back off correctly
    const retryAfterSecs = applyRateLimits(request, url, clientIp);
    if (retryAfterSecs > 0) {
      response.setHeader('Retry-After', retryAfterSecs);
      log.warn(`[RATE] rate limited (${clientIp}) ${request.method} ${url.pathname} (retry-after: ${retryAfterSecs}s)`);
      await sendJson(request, response, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.', retryAfter: retryAfterSecs });
      return;
    }

    // Admin IP whitelist — block non-whitelisted IPs from admin routes
    if (adminIpWhitelist && url.pathname.startsWith('/api/admin/')) {
      if (!isAdminIpAllowed(clientIp)) {
        log.warn(`[IP-BLOCK] admin access denied: ${clientIp} → ${url.pathname}`);
        await sendJson(request, response, 403, { error: '접근이 허용되지 않은 IP입니다.' });
        return;
      }
    }

    try {
      if (!initialized) {
        if (!initPromise) initPromise = store.init();
        try {
          await initPromise;
          initialized = true;
        } catch (err) {
          initPromise = null; // allow retry on next request
          throw err;
        }
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        let dbStatus = 'ok';
        try {
          await store.getSubmissionCounts();
        } catch {
          dbStatus = 'error';
        }
        const mem = process.memoryUsage();
        await sendJson(request, response, dbStatus === 'ok' ? 200 : 503, {
          status: dbStatus === 'ok' ? 'ok' : 'degraded',
          db: dbStatus,
          uptime: Math.floor(process.uptime()),
          startedAt: SERVER_STARTED_AT,
          version: PKG_VERSION,
          memory: {
            rssMb: Math.round(mem.rss / 1024 / 1024),
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
          }
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/metrics') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const times = metrics.responseTimes;
        const avgResponseMs = times.length > 0
          ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          : 0;
        const p99ResponseMs = times.length > 0
          ? [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.99)]
          : 0;
        await sendJson(request, response, 200, {
          requests: metrics.requests,
          errors: metrics.errors,
          errorRate: metrics.requests > 0 ? Number((metrics.errors / metrics.requests).toFixed(4)) : 0,
          avgResponseMs,
          p99ResponseMs,
          sampleSize: times.length
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/status') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const mem = process.memoryUsage();
        let dbSizeBytes = 0;
        try {
          const dbStat = await stat(config.dbFile);
          dbSizeBytes = dbStat.size;
        } catch { /* DB file may not exist in fresh envs */ }
        await sendJson(request, response, 200, {
          status: 'ok',
          uptime: Math.floor(process.uptime()),
          startedAt: SERVER_STARTED_AT,
          version: PKG_VERSION,
          db: {
            sizeBytes: dbSizeBytes,
            sizeMb: Math.round(dbSizeBytes / 1024 / 1024 * 10) / 10
          },
          activeConnections,
          memory: {
            rssMb: Math.round(mem.rss / 1024 / 1024),
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024)
          },
          metrics: {
            requests: metrics.requests,
            errors: metrics.errors
          }
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/docs') {
        await sendJson(request, response, 200, {
          version: PKG_VERSION,
          envelope: 'Object responses include { success: boolean, ...data }. Arrays are returned as-is.',
          errorFormat: '{ success: false, error: "Korean error message" }',
          endpoints: [
            { method: 'GET',  path: '/health',      auth: false, description: '서버 상태 및 DB 연결 확인',
              responseExample: { success: true, status: 'ok', db: 'ok', uptime: 120 } },
            { method: 'GET',  path: '/api/docs',    auth: false, description: 'API 문서 (이 페이지)' },
            { method: 'GET',  path: '/api/status',  auth: true,  description: '상세 서버 모니터링',
              responseExample: { success: true, status: 'ok', uptime: 120, db: { sizeBytes: 49152, sizeMb: 0 }, activeConnections: 2 } },
            { method: 'GET',  path: '/api/metrics', auth: true,  description: '요청 통계 (p99 응답시간, 에러율)',
              responseExample: { success: true, requests: 500, errors: 2, avgResponseMs: 12, p99ResponseMs: 48 } },
            { method: 'GET',  path: '/api/bootstrap', auth: false, description: '앱 초기화 데이터 (지역, 제품, 제출 목록)' },
            { method: 'GET',  path: '/api/survey-stats', auth: false, description: '지역별 제출 현황 및 좌표' },
            { method: 'GET',  path: '/api/daily-summary', auth: false, description: '일별 집계 요약',
              queryParams: { date: 'YYYY-MM-DD (기본: 오늘)' },
              responseExample: { success: true, date: '2026-03-15', totalSubmissions: 42, uniqueResearchers: 8 } },
            { method: 'GET',  path: '/api/daily-report', auth: false, description: '일별 HTML 리포트',
              queryParams: { date: 'YYYY-MM-DD (기본: 오늘)' } },
            { method: 'GET',  path: '/api/geocode',  auth: false, description: '주소 → 좌표 변환',
              queryParams: { query: '검색할 주소' } },
            { method: 'GET',  path: '/api/reverse-geocode', auth: false, description: '좌표 → 주소 변환',
              queryParams: { lat: '위도', lng: '경도' } },
            { method: 'GET',  path: '/api/stats',   auth: true,  description: '기간별/조사자별 집계 통계',
              queryParams: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' },
              responseExample: { success: true, total: 100, byResearcher: [{ name: '홍길동', count: 20 }], byArea: [], byDay: [] } },
            { method: 'GET',  path: '/api/price-outliers', auth: true, description: '가격 이상치 감지 (±Nσ)',
              queryParams: { sigma: '표준편차 배수 (기본 2, 범위 1~5)' },
              responseExample: { success: true, sigma: 2, total: 3, outliers: [{ product: 'Vita500', price: 9999, deviation: 3.2 }] } },
            { method: 'POST', path: '/api/submissions', auth: false, description: '새 시장조사 제출 (중복 감지 포함)',
              requestExample: { researcher: { name: '홍길동', residenceArea: '서울 중부' }, survey: { region: '강남구', storeType: '약국', storeName: '서울약국' }, prices: [{ productId: 'vita500', size: '100ml', price: 1200 }] },
              responseExample: { success: true, id: 'uuid-string', sync: { mode: 'local' } } },
            { method: 'POST', path: '/api/admin/login', auth: false, description: '관리자 로그인 → Bearer 토큰 발급',
              requestExample: { password: 'your-password' },
              responseExample: { success: true, token: 'uuid-string' } },
            { method: 'GET',  path: '/api/admin/verify', auth: true, description: '토큰 유효성 확인',
              responseExample: { success: true, ok: true } },
            { method: 'POST', path: '/api/admin/refresh', auth: true, description: '토큰 갱신 (새 토큰 발급)',
              responseExample: { success: true, token: 'new-uuid-string' } },
            { method: 'GET',  path: '/api/admin/submissions', auth: true, description: '전체 제출 목록',
              queryParams: { page: '페이지 번호', limit: `페이지 크기 (최대 ${PAGINATION_MAX_LIMIT})` } },
            { method: 'GET',  path: '/api/admin/settings', auth: true, description: '커스텀 설정 조회' },
            { method: 'POST', path: '/api/admin/settings', auth: true, description: '커스텀 설정 저장',
              requestExample: { key: 'customAreas', value: ['서울 중부', '서울 동부'] } },
            { method: 'POST', path: '/api/admin/change-password', auth: true, description: '관리자 비밀번호 변경',
              requestExample: { currentPassword: 'old', newPassword: 'new-secure-pw' } },
            { method: 'POST', path: '/api/admin/webhook', auth: true, description: '웹훅 URL 및 이벤트 설정',
              requestExample: { url: 'https://hooks.example.com/notify', events: ['new_submission'] } },
            { method: 'POST', path: '/api/admin/import', auth: true, description: '데이터 일괄 가져오기',
              requestExample: { submissions: [] } },
            { method: 'GET',  path: '/api/backup', auth: true, description: '필터된 데이터 내보내기',
              queryParams: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', researcher: '조사자명', area: '지역명' } },
            { method: 'POST', path: '/api/submissions/delete', auth: true, description: '제출 삭제',
              requestExample: { submissionId: 'uuid' } },
            { method: 'POST', path: '/api/assignments/override', auth: true, description: '배정 지역 수동 변경',
              requestExample: { submissionId: 'uuid', assignedArea: '서울 동부', reason: '요청에 의한 변경' } },
            { method: 'GET',  path: '/api/admin/researchers', auth: true, description: '조사자 목록 + 최근 활동 + 기여도',
              responseExample: { success: true, total: 5, researchers: [{ name: '홍길동', totalSubmissions: 12, lastActiveAt: '2026-03-15T10:00:00.000Z', uniqueAreas: 3, uniqueStores: 8, avgCompleteness: 85 }] } },
            { method: 'GET',  path: '/api/admin/areas', auth: true, description: '지역별 통계 (커버리지, 평균 완료도)',
              responseExample: { success: true, totalAreas: 10, areas: [{ area: '서울 중부', submissionCount: 20, uniqueResearchers: 4, coverageRate: 0.8, avgCompleteness: 90 }] } },
            { method: 'GET',  path: '/api/export', auth: true, description: '다양한 형식으로 데이터 내보내기',
              queryParams: { format: 'csv | json | xlsx-ready (기본: json)', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', researcher: '조사자명', area: '지역명' } }
          ]
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/stats') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const statsFrom = url.searchParams.get('from');
        const statsTo = url.searchParams.get('to');
        const allSubmissions = await store.listSubmissions();
        const filtered = allSubmissions.filter((s) => {
          const date = s.createdAt?.slice(0, 10) || '';
          if (statsFrom && date < statsFrom) return false;
          if (statsTo && date > statsTo) return false;
          return true;
        });

        // Per-researcher stats
        const researcherMap = {};
        for (const s of filtered) {
          const name = s.researcher?.name || '미상';
          if (!researcherMap[name]) researcherMap[name] = { name, count: 0, areas: new Set(), stores: new Set() };
          researcherMap[name].count++;
          if (s.assignment?.currentArea) researcherMap[name].areas.add(s.assignment.currentArea);
          if (s.survey?.storeName) researcherMap[name].stores.add(s.survey.storeName);
        }
        const byResearcher = Object.values(researcherMap).map((r) => ({
          name: r.name, count: r.count, uniqueAreas: r.areas.size, uniqueStores: r.stores.size
        })).sort((a, b) => b.count - a.count);

        // Per-area stats
        const areaMap = {};
        for (const s of filtered) {
          const area = s.assignment?.currentArea || '미배정';
          areaMap[area] = (areaMap[area] || 0) + 1;
        }
        const byArea = Object.entries(areaMap)
          .map(([area, count]) => ({ area, count }))
          .sort((a, b) => b.count - a.count);

        // Per-day stats
        const dayMap = {};
        for (const s of filtered) {
          const day = s.createdAt?.slice(0, 10) || '미상';
          dayMap[day] = (dayMap[day] || 0) + 1;
        }
        const byDay = Object.entries(dayMap)
          .map(([date, count]) => ({ date, count }))
          .sort((a, b) => a.date.localeCompare(b.date));

        await sendJson(request, response, 200, {
          from: statsFrom || null,
          to: statsTo || null,
          total: filtered.length,
          byResearcher,
          byArea,
          byDay,
          averagePrices: buildAveragePrices(filtered)
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/price-outliers') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const sigma = Math.max(1, Math.min(5, Number(url.searchParams.get('sigma') || 2)));
        const allSubs = await store.listSubmissions();

        // Build price distributions per product+size key
        const priceMap = {};
        for (const s of allSubs) {
          for (const p of (s.prices || [])) {
            const key = `${p.productLabel || p.productId}|${p.size}`;
            if (!priceMap[key]) priceMap[key] = { label: p.productLabel || p.productId, size: p.size, entries: [] };
            const num = Number(String(p.price).replace(/[^0-9]/g, ''));
            if (num > 0) {
              priceMap[key].entries.push({
                submissionId: s.id, price: num,
                researcher: s.researcher?.name, storeName: s.survey?.storeName, createdAt: s.createdAt
              });
            }
          }
        }

        const outliers = [];
        for (const group of Object.values(priceMap)) {
          if (group.entries.length < 3) continue; // too few samples for meaningful stats
          const prices = group.entries.map((e) => e.price);
          const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
          const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / prices.length;
          const stdDev = Math.sqrt(variance);
          if (stdDev === 0) continue; // all prices identical
          const lower = mean - sigma * stdDev;
          const upper = mean + sigma * stdDev;
          for (const entry of group.entries) {
            if (entry.price < lower || entry.price > upper) {
              outliers.push({
                product: group.label, size: group.size,
                price: entry.price,
                mean: Math.round(mean), stdDev: Math.round(stdDev), sigma,
                deviation: Number(((entry.price - mean) / stdDev).toFixed(2)),
                submissionId: entry.submissionId, researcher: entry.researcher,
                storeName: entry.storeName, createdAt: entry.createdAt
              });
            }
          }
        }
        outliers.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
        await sendJson(request, response, 200, { sigma, total: outliers.length, outliers });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/researchers') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const allSubs = await store.listSubmissions();
        const researcherMap = {};
        for (const s of allSubs) {
          const name = s.researcher?.name || '미상';
          if (!researcherMap[name]) {
            researcherMap[name] = {
              name,
              totalSubmissions: 0,
              lastActiveAt: null,
              uniqueAreas: new Set(),
              uniqueStores: new Set(),
              completenessScores: []
            };
          }
          const r = researcherMap[name];
          r.totalSubmissions++;
          if (s.createdAt && (!r.lastActiveAt || s.createdAt > r.lastActiveAt)) {
            r.lastActiveAt = s.createdAt;
          }
          if (s.assignment?.currentArea) r.uniqueAreas.add(s.assignment.currentArea);
          if (s.survey?.storeName) r.uniqueStores.add(s.survey.storeName);
          if (typeof s.completenessScore === 'number') r.completenessScores.push(s.completenessScore);
        }
        const researchers = Object.values(researcherMap).map((r) => ({
          name: r.name,
          totalSubmissions: r.totalSubmissions,
          lastActiveAt: r.lastActiveAt,
          uniqueAreas: r.uniqueAreas.size,
          uniqueStores: r.uniqueStores.size,
          avgCompleteness: r.completenessScores.length > 0
            ? Math.round(r.completenessScores.reduce((a, b) => a + b, 0) / r.completenessScores.length)
            : null
        })).sort((a, b) => b.totalSubmissions - a.totalSubmissions);
        await sendJson(request, response, 200, { total: researchers.length, researchers });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/areas') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const allSubs = await store.listSubmissions();
        const customAreas = await store.getSetting('customAreas');
        const activeAreas = customAreas || config.areas;
        const areaMap = {};
        for (const area of activeAreas) {
          areaMap[area] = { area, submissionCount: 0, uniqueResearchers: new Set(), completenessScores: [] };
        }
        for (const s of allSubs) {
          const area = s.assignment?.currentArea;
          if (area && areaMap[area]) {
            areaMap[area].submissionCount++;
            if (s.researcher?.name) areaMap[area].uniqueResearchers.add(s.researcher.name);
            if (typeof s.completenessScore === 'number') areaMap[area].completenessScores.push(s.completenessScore);
          }
        }
        const totalResearchers = new Set(allSubs.map((s) => s.researcher?.name).filter(Boolean)).size;
        const areas = Object.values(areaMap).map((a) => ({
          area: a.area,
          submissionCount: a.submissionCount,
          uniqueResearchers: a.uniqueResearchers.size,
          coverageRate: totalResearchers > 0 ? Number((a.uniqueResearchers.size / totalResearchers).toFixed(2)) : 0,
          avgCompleteness: a.completenessScores.length > 0
            ? Math.round(a.completenessScores.reduce((x, y) => x + y, 0) / a.completenessScores.length)
            : null
        })).sort((a, b) => b.submissionCount - a.submissionCount);
        await sendJson(request, response, 200, { totalAreas: areas.length, areas });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/export') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const format = url.searchParams.get('format') || 'json';
        const exportFrom = url.searchParams.get('from');
        const exportTo = url.searchParams.get('to');
        const exportResearcher = url.searchParams.get('researcher');
        const exportArea = url.searchParams.get('area');

        let submissions = await store.listSubmissions();
        if (exportFrom || exportTo) {
          submissions = submissions.filter((s) => {
            const date = s.createdAt?.slice(0, 10) || '';
            if (exportFrom && date < exportFrom) return false;
            if (exportTo && date > exportTo) return false;
            return true;
          });
        }
        if (exportResearcher) submissions = submissions.filter((s) => s.researcher?.name === exportResearcher);
        if (exportArea) submissions = submissions.filter((s) => s.assignment?.currentArea === exportArea);

        if (format === 'csv') {
          const CSV_HEADERS = ['id', 'createdAt', 'researcherName', 'residenceArea', 'region', 'storeType', 'storeName', 'posCount', 'assignedArea', 'completenessScore', 'notes', 'priceCount'];
          const escCsv = (v) => {
            const s = v == null ? '' : String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
          };
          const rows = submissions.map((s) => [
            s.id, s.createdAt,
            s.researcher?.name, s.researcher?.residenceArea,
            s.survey?.region, s.survey?.storeType, s.survey?.storeName, s.survey?.posCount ?? '',
            s.assignment?.currentArea, s.completenessScore ?? '',
            s.notes || '', (s.prices || []).length
          ].map(escCsv).join(','));
          const csv = [CSV_HEADERS.join(','), ...rows].join('\r\n');
          response.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="ionroad-export-${new Date().toISOString().slice(0, 10)}.csv"`,
            'Content-Length': Buffer.byteLength(csv)
          });
          response.end(csv);
          return;
        }

        if (format === 'xlsx-ready') {
          const HEADERS = ['id', 'createdAt', 'researcherName', 'residenceArea', 'region', 'storeType', 'storeName', 'posCount', 'assignedArea', 'completenessScore', 'notes', 'priceCount'];
          const rows = submissions.map((s) => [
            s.id, s.createdAt,
            s.researcher?.name || '', s.researcher?.residenceArea || '',
            s.survey?.region || '', s.survey?.storeType || '', s.survey?.storeName || '', s.survey?.posCount ?? 0,
            s.assignment?.currentArea || '', s.completenessScore ?? 0,
            s.notes || '', (s.prices || []).length
          ]);
          await sendJson(request, response, 200, { format: 'xlsx-ready', headers: HEADERS, rows, total: rows.length });
          return;
        }

        // Default: JSON (same as /api/backup but named /api/export)
        const timestamp = new Date().toISOString();
        const filters = { from: exportFrom || null, to: exportTo || null, researcher: exportResearcher || null, area: exportArea || null };
        await sendJson(request, response, 200, { format: 'json', timestamp, filters, totalSubmissions: submissions.length, submissions });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        await serveStatic(response, path.resolve('src/client/index.html'), request);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        await serveStatic(response, path.resolve('src/client/app.js'), request);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/styles.css') {
        await serveStatic(response, path.resolve('src/client/styles.css'), request);
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico')) {
        await serveStatic(response, path.resolve('src/client/favicon.svg'), request);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/manifest.json') {
        await serveStatic(response, path.resolve('src/client/manifest.json'), request);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/sw.js') {
        const swPath = path.resolve('src/client/sw.js');
        const contents = await readFile(swPath);
        response.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        response.end(contents);
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png')) {
        await serveStatic(response, path.resolve('src/client', url.pathname.slice(1)), request);
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        await serveStatic(response, path.resolve(config.uploadsDir, url.pathname.replace('/uploads/', '')), request);
        return;
      }

      // ── Admin page static files ──
      if (request.method === 'GET' && url.pathname === '/admin') {
        await serveStatic(response, path.resolve('src/client/admin.html'), request);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/admin.js') {
        await serveStatic(response, path.resolve('src/client/admin.js'), request);
        return;
      }

      // ── Admin auth endpoints ──
      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        const body = await collectJsonBody(request, MAX_AUTH_BODY_BYTES);
        const dbPassword = await store.getAdminPassword();
        const activePassword = dbPassword || config.adminPassword;
        if (await verifyPassword(body.password, activePassword)) {
          await sendJson(request, response, 200, { token: createAdminToken() });
        } else {
          await sendJson(request, response, 401, { error: '비밀번호가 틀렸어요.' });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/verify') {
        if (checkAuth(request)) {
          await sendJson(request, response, 200, { ok: true });
        } else {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/refresh') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        // Issue a fresh token (old token remains valid until TTL thanks to sliding window)
        await sendJson(request, response, 200, { token: createAdminToken() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/submissions') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const all = await store.listSubmissions();
        const pageParam = url.searchParams.get('page');
        const limitParam = url.searchParams.get('limit');
        if (pageParam !== null || limitParam !== null) {
          const page = Math.max(1, Number(pageParam) || 1);
          const limit = Math.min(PAGINATION_MAX_LIMIT, Math.max(1, Number(limitParam) || 20));
          const total = all.length;
          const items = all.slice((page - 1) * limit, page * limit);
          await sendJson(request, response, 200, { total, page, limit, items });
        } else {
          await sendJson(request, response, 200, all);
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/settings') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const [customAreas, customProducts, customStoreTypes] = await Promise.all([
          store.getSetting('customAreas'),
          store.getSetting('customProducts'),
          store.getSetting('customStoreTypes')
        ]);
        await sendJson(request, response, 200, { customAreas, customProducts, customStoreTypes });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/settings') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const body = await collectJsonBody(request, MAX_SETTINGS_BODY_BYTES);
        const allowedKeys = ['customAreas', 'customProducts', 'customStoreTypes'];
        if (!body.key || !allowedKeys.includes(body.key)) {
          await sendJson(request, response, 400, { error: '유효하지 않은 설정 키입니다.' });
          return;
        }
        if (!Array.isArray(body.value)) {
          await sendJson(request, response, 400, { error: '값은 배열 형식이어야 합니다.' });
          return;
        }
        await store.setSetting(body.key, body.value);
        await sendJson(request, response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/daily-summary') {
        const dateParam = url.searchParams.get('date');
        const targetDate = dateParam || new Date().toISOString().slice(0, 10);
        const submissions = await store.listSubmissions();
        const daySubs = filterSubmissionsByDate(submissions, targetDate);

        const totalSubmissions = daySubs.length;
        const uniqueResearchers = new Set(daySubs.map((s) => s.researcher.name)).size;
        const areasCovered = new Set(daySubs.map((s) => s.assignment?.currentArea).filter(Boolean)).size;
        const averagePrices = buildAveragePrices(daySubs);

        // Top researcher
        const researcherCounts = {};
        daySubs.forEach((s) => { researcherCounts[s.researcher.name] = (researcherCounts[s.researcher.name] || 0) + 1; });
        const topResearcherEntry = Object.entries(researcherCounts).sort((a, b) => b[1] - a[1])[0];
        const topResearcher = topResearcherEntry ? { name: topResearcherEntry[0], count: topResearcherEntry[1] } : null;

        // Top store
        const storeCounts = {};
        daySubs.forEach((s) => { storeCounts[s.survey.storeName] = (storeCounts[s.survey.storeName] || 0) + 1; });
        const topStoreEntry = Object.entries(storeCounts).sort((a, b) => b[1] - a[1])[0];
        const topStore = topStoreEntry ? { name: topStoreEntry[0], count: topStoreEntry[1] } : null;

        await sendJson(request, response, 200, { date: targetDate, totalSubmissions, uniqueResearchers, areasCovered, averagePrices, topResearcher, topStore });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/daily-report') {
        const dateParam = url.searchParams.get('date');
        const targetDate = dateParam || new Date().toISOString().slice(0, 10);
        const submissions = await store.listSubmissions();
        const daySubs = filterSubmissionsByDate(submissions, targetDate);

        const totalSubmissions = daySubs.length;
        const uniqueResearchers = new Set(daySubs.map((s) => s.researcher.name)).size;
        const regionsCovered = new Set(daySubs.map((s) => s.survey.region).filter(Boolean)).size;
        const avgPrices = buildAveragePrices(daySubs);

        // Researcher contributions
        const researcherCounts = {};
        daySubs.forEach((s) => { researcherCounts[s.researcher.name] = (researcherCounts[s.researcher.name] || 0) + 1; });
        const researcherList = Object.entries(researcherCounts).sort((a, b) => b[1] - a[1]);

        const priceRows = avgPrices.map((p) =>
          `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${p.label}</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${p.size}</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${p.avg.toLocaleString()}원</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${p.count}</td></tr>`
        ).join('');

        const researcherRows = researcherList.map(([name, count]) =>
          `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${name}</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${count}건</td></tr>`
        ).join('');

        const html = `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff">
<tr><td style="background:#1e40af;padding:24px;text-align:center">
<h1 style="color:#ffffff;margin:0;font-size:22px">&#127758; 이온로드 일일 시장조사 리포트</h1>
<p style="color:#93c5fd;margin:8px 0 0;font-size:14px">${targetDate}</p>
</td></tr>
<tr><td style="padding:24px">
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
<tr>
<td style="width:33%;text-align:center;padding:16px;background:#eff6ff;border-radius:8px">
<div style="font-size:28px;font-weight:bold;color:#1e40af">${totalSubmissions}</div>
<div style="font-size:12px;color:#6b7280;margin-top:4px">총 제출</div>
</td>
<td style="width:8px"></td>
<td style="width:33%;text-align:center;padding:16px;background:#f0fdf4;border-radius:8px">
<div style="font-size:28px;font-weight:bold;color:#166534">${uniqueResearchers}</div>
<div style="font-size:12px;color:#6b7280;margin-top:4px">조사자</div>
</td>
<td style="width:8px"></td>
<td style="width:33%;text-align:center;padding:16px;background:#fefce8;border-radius:8px">
<div style="font-size:28px;font-weight:bold;color:#854d0e">${regionsCovered}</div>
<div style="font-size:12px;color:#6b7280;margin-top:4px">지역 커버리지</div>
</td>
</tr>
</table>
${avgPrices.length > 0 ? `<h2 style="font-size:16px;color:#1f2937;margin:0 0 12px;border-bottom:2px solid #1e40af;padding-bottom:8px">제품별 평균 가격</h2>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;font-size:14px">
<tr style="background:#f9fafb">
<th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #d1d5db">제품</th>
<th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #d1d5db">규격</th>
<th style="padding:8px 12px;text-align:right;font-weight:600;border-bottom:2px solid #d1d5db">평균가</th>
<th style="padding:8px 12px;text-align:center;font-weight:600;border-bottom:2px solid #d1d5db">샘플</th>
</tr>
${priceRows}
</table>` : '<p style="color:#6b7280;font-size:14px">오늘 가격 데이터가 없습니다.</p>'}
${researcherList.length > 0 ? `<h2 style="font-size:16px;color:#1f2937;margin:0 0 12px;border-bottom:2px solid #1e40af;padding-bottom:8px">조사자별 기여도</h2>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;font-size:14px">
<tr style="background:#f9fafb">
<th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #d1d5db">조사자</th>
<th style="padding:8px 12px;text-align:center;font-weight:600;border-bottom:2px solid #d1d5db">제출 수</th>
</tr>
${researcherRows}
</table>` : ''}
<div style="text-align:center;margin-top:24px">
<a href="/admin" style="display:inline-block;background:#1e40af;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:14px;font-weight:600">관리자 대시보드 보기</a>
</div>
</td></tr>
<tr><td style="background:#f9fafb;padding:16px;text-align:center;font-size:12px;color:#9ca3af">
이온로드 시장조사 시스템 &bull; 자동 생성 리포트
</td></tr>
</table>
</body>
</html>`;

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const submissions = await store.listSubmissions();
        const assignmentOverrides = await store.listAssignmentOverrides();
        const [customAreas, customProducts, customStoreTypes] = await Promise.all([
          store.getSetting('customAreas'),
          store.getSetting('customProducts'),
          store.getSetting('customStoreTypes')
        ]);
        await sendJson(request, response, 200, {
          areas: customAreas || config.areas,
          products: customProducts || config.products,
          storeTypeTemplates: customStoreTypes || config.storeTypeTemplates,
          submissions,
          assignmentOverrides,
          adminTokenConfigured: Boolean(config.adminToken)
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/geocode') {
        const query = url.searchParams.get('query') || '';
        const result = await geocoder.geocode(query);
        await sendJson(request, response, 200, result);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/reverse-geocode') {
        const lat = url.searchParams.get('lat');
        const lng = url.searchParams.get('lng');
        if (!lat || !lng) {
          await sendJson(request, response, 400, { error: 'lat과 lng 파라미터가 필요합니다.' });
          return;
        }
        const kakaoUrl = `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lng}&y=${lat}`;
        const fetchFn = options.fetchImpl || fetch;
        const kakaoRes = await fetchFn(kakaoUrl, {
          headers: { Authorization: `KakaoAK ${config.kakaoRestApiKey}` }
        });
        const kakaoData = await kakaoRes.json();
        const doc = kakaoData.documents && kakaoData.documents[0];
        const address = doc
          ? (doc.road_address ? doc.road_address.address_name : doc.address.address_name)
          : '';
        await sendJson(request, response, 200, { address, lat: Number(lat), lng: Number(lng) });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/survey-stats') {
        const customAreas = await store.getSetting('customAreas');
        const activeAreas = customAreas || config.areas;
        const submissionCounts = await store.getSubmissionCounts();
        const areaCoordinates = await geocodeAreas(activeAreas);
        await sendJson(request, response, 200, {
          areas: activeAreas.map((area) => ({
            area,
            submissionCount: submissionCounts[area] || 0,
            coordinates: areaCoordinates[area]
              ? { lat: areaCoordinates[area].lat, lng: areaCoordinates[area].lng }
              : null,
            address: areaCoordinates[area]?.address || null
          }))
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/submissions') {
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        const customAreas = await store.getSetting('customAreas');
        const activeAreas = customAreas || config.areas;
        const dynamicConfig = { ...config, areas: activeAreas };
        const payload = validateSubmission(body, dynamicConfig);

        // Duplicate detection: same researcher + store + today
        const today = new Date().toISOString().slice(0, 10);
        const existingForDuplicate = await store.listSubmissions();
        const duplicateEntry = existingForDuplicate.find((s) =>
          s.researcher?.name === payload.researcher.name &&
          s.survey?.storeName === payload.survey.storeName &&
          s.createdAt?.slice(0, 10) === today
        );
        if (duplicateEntry) {
          log.warn(`[DUPLICATE] ${payload.researcher.name} @ ${payload.survey.storeName} already submitted today (${duplicateEntry.id})`);
        }

        const submissionCounts = await store.getSubmissionCounts();
        const [residenceCoord, surveyCoord, areaCoords] = await Promise.all([
          geocoder.tryGeocode(payload.researcher.residenceArea),
          geocoder.tryGeocode(payload.survey.region),
          geocodeAreas(activeAreas)
        ]);

        const hasDistanceInputs =
          Boolean(residenceCoord) && Object.keys(areaCoords).length === activeAreas.length;

        const assignment = hasDistanceInputs
          ? assignAreaByDistance({
              residenceCoord,
              areaCoords,
              submissionCounts
            })
          : assignArea({
              residenceArea: payload.researcher.residenceArea,
              areas: activeAreas,
              submissionCounts
            });

        // Completeness score (0~100)
        let completenessScore = 0;
        if (payload.researcher.name && payload.survey.storeName && payload.survey.region) completenessScore += 20;
        if (payload.prices.length > 0) completenessScore += 30;
        if (payload.photoDataUrl) completenessScore += 20;
        if (payload.notes) completenessScore += 10;
        if (body.gpsLat != null && body.gpsLng != null) completenessScore += 20;

        const submission = await store.createSubmission({
          ...payload,
          completenessScore,
          researcher: {
            ...payload.researcher,
            ...(residenceCoord ? { coordinates: { lat: residenceCoord.lat, lng: residenceCoord.lng } } : {})
          },
          survey: {
            ...payload.survey,
            ...(surveyCoord ? { coordinates: { lat: surveyCoord.lat, lng: surveyCoord.lng } } : {})
          },
          assignment: {
            currentArea: assignment.assignedArea,
            candidateOrder: assignment.candidateOrder,
            method: hasDistanceInputs ? 'distance-fairness-blend' : 'residence-proximity-then-fairness'
          }
        });

        // Fire-and-forget webhook notification (with retry)
        (async () => {
          try {
            const [webhookUrl, webhookEvents] = await Promise.all([
              store.getSetting('webhookUrl'),
              store.getSetting('webhookEvents')
            ]);
            if (!webhookUrl) return;
            const events = webhookEvents || ['new_submission', 'daily_summary'];
            if (!events.includes('new_submission')) return;
            const fetchFn = options.fetchImpl || fetch;
            await sendWebhookWithRetry(webhookUrl, {
              event: 'new_submission',
              data: {
                researcher: payload.researcher.name,
                store: payload.survey.storeName,
                region: payload.survey.region,
                priceCount: payload.prices.length,
                timestamp: new Date().toISOString()
              }
            }, fetchFn);
          } catch { /* ignored */ }
        })();

        const responsePayload = duplicateEntry
          ? { ...submission, duplicate: true, duplicateId: duplicateEntry.id }
          : submission;
        await sendJson(request, response, 201, responsePayload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/assignments/override') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        if (!body.submissionId || !body.assignedArea) {
          throw new ValidationError('submissionId와 assignedArea는 필수입니다.');
        }
        const updated = await store.overrideAssignment({
          submissionId: body.submissionId,
          assignedArea: body.assignedArea,
          reason: body.reason || '',
          adminName: body.adminName || 'Admin'
        });
        await sendJson(request, response, 200, updated);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/backup') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        let submissions = await store.listSubmissions();
        const exportFrom = url.searchParams.get('from');
        const exportTo = url.searchParams.get('to');
        const exportResearcher = url.searchParams.get('researcher');
        const exportArea = url.searchParams.get('area');
        if (exportFrom || exportTo) {
          submissions = submissions.filter((s) => {
            const date = s.createdAt?.slice(0, 10) || '';
            if (exportFrom && date < exportFrom) return false;
            if (exportTo && date > exportTo) return false;
            return true;
          });
        }
        if (exportResearcher) {
          submissions = submissions.filter((s) => s.researcher?.name === exportResearcher);
        }
        if (exportArea) {
          submissions = submissions.filter((s) => s.assignment?.currentArea === exportArea);
        }
        const timestamp = new Date().toISOString();
        const filters = { from: exportFrom || null, to: exportTo || null, researcher: exportResearcher || null, area: exportArea || null };
        await sendJson(request, response, 200, { timestamp, filters, totalSubmissions: submissions.length, submissions });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/submissions/delete') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        if (!body.submissionId) throw new ValidationError('submissionId is required.');
        await store.deleteSubmission(body.submissionId);
        await sendJson(request, response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/import') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        if (!Array.isArray(body.submissions)) {
          await sendJson(request, response, 400, { error: 'submissions 배열이 필요합니다.' });
          return;
        }
        const result = await store.importSubmissions(body.submissions);
        await sendJson(request, response, 200, result);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/webhook') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const body = await collectJsonBody(request, MAX_SETTINGS_BODY_BYTES);
        if (!body.url || typeof body.url !== 'string') {
          await sendJson(request, response, 400, { error: 'URL을 입력해주세요.' });
          return;
        }
        const validEvents = ['new_submission', 'daily_summary'];
        const events = Array.isArray(body.events) ? body.events.filter((e) => validEvents.includes(e)) : validEvents;
        await store.setSetting('webhookUrl', body.url);
        await store.setSetting('webhookEvents', events);
        await sendJson(request, response, 200, { ok: true, url: body.url, events });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/change-password') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const body = await collectJsonBody(request, MAX_AUTH_BODY_BYTES);
        if (!body.currentPassword || !body.newPassword) {
          await sendJson(request, response, 400, { error: '현재 비밀번호와 새 비밀번호를 입력해주세요.' });
          return;
        }
        if (String(body.newPassword).length < 4) {
          await sendJson(request, response, 400, { error: '새 비밀번호는 4자 이상이어야 합니다.' });
          return;
        }
        const dbPassword = await store.getAdminPassword();
        const currentActual = dbPassword || config.adminPassword;
        if (!await verifyPassword(body.currentPassword, currentActual)) {
          await sendJson(request, response, 401, { error: '현재 비밀번호가 틀렸어요.' });
          return;
        }
        await store.setAdminPassword(await hashPassword(body.newPassword));
        await sendJson(request, response, 200, { ok: true });
        return;
      }

      await sendJson(request, response, 404, { error: '요청하신 경로를 찾을 수 없습니다.' });
    } catch (error) {
      const isClientError = error.isValidationError ||
        error instanceof SyntaxError ||
        error.message === 'Request body too large.';
      if (isClientError) {
        log.warn(`[400] ${request.method} ${url.pathname} (${clientIp}): ${error.message}`);
        await sendJson(request, response, 400, { error: error.message });
      } else {
        log.error(`[500] ${request.method} ${url.pathname} (${clientIp}): ${error.message}`);
        log.error(error.stack);
        await sendJson(request, response, 500, { error: '서버 오류가 발생했습니다.' });
      }
    }
  });

  // Track open connections for /api/status
  server.on('connection', (socket) => {
    activeConnections++;
    socket.once('close', () => { activeConnections--; });
  });

  server._store = store;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  const server = createApp(config);
  const host = '0.0.0.0';

  function shutdown(signal) {
    log.info(`${signal} received - shutting down gracefully...`);
    closeApp(server).then(() => {
      log.info('Server closed.');
      process.exit(0);
    }).catch((error) => {
      log.error('Graceful shutdown failed.', error);
      process.exit(1);
    });
    setTimeout(() => {
      log.error('Forceful shutdown after timeout.');
      process.exit(1);
    }, 5000);
  }

  // Register signal handlers before the async startup chain
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Sequential startup: validate env → DB init → integrity check → WAL checkpoint → backup → bind port → print banner
  (async () => {
    try {
      // Environment validation — warn early about misconfigurations
      const envWarnings = validateEnvironment(config);
      for (const w of envWarnings) log.warn(`[CONFIG] ${w}`);

      await server._store.init();
      await server._store.getSubmissionCounts();
      log.info('[DB] integrity check passed');

      walCheckpoint(server._store);
      setInterval(() => walCheckpoint(server._store), 6 * 60 * 60_000).unref(); // every 6h

      await backupDatabase(config.dbFile);
      setInterval(() => backupDatabase(config.dbFile), BACKUP_INTERVAL_MS).unref();

      await new Promise((resolve) => server.listen(config.port, host, resolve));

      const sheetsStatus = config.googleSheets?.enabled ? '✓ 활성' : '✗ 비활성';
      const tokenStatus  = config.adminToken ? '✓ 설정됨' : '✗ 미설정 (비밀번호 로그인만 가능)';
      log.info([
        '',
        '┌─────────────────────────────────────────────────┐',
        `│  이온로드 시장조사 v${PKG_VERSION.padEnd(6)}                         │`,
        '├─────────────────────────────────────────────────┤',
        `│  URL      : http://${host}:${String(config.port).padEnd(29)}│`,
        `│  DB       : ${path.relative(process.cwd(), config.dbFile).padEnd(36)}│`,
        `│  Sheets   : ${sheetsStatus.padEnd(36)}│`,
        `│  AdminTkn : ${tokenStatus.padEnd(36)}│`,
        `│  Started  : ${SERVER_STARTED_AT.padEnd(36)}│`,
        '└─────────────────────────────────────────────────┘'
      ].join('\n'));
    } catch (err) {
      log.error('[STARTUP] failed:', err.message);
      process.exit(1);
    }
  })();
}
