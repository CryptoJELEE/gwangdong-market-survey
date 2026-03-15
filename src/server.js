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

// Structured logger — keeps log levels distinct for filtering/aggregation
const log = {
  info:  (...args) => console.log('[INFO] ', ...args),
  warn:  (...args) => console.warn('[WARN] ', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};

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
  return submissions.filter((s) => {
    const d = new Date(s.createdAt);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return ymd === targetDate;
  });
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
 * Automatically compresses with gzip or deflate when the payload exceeds
 * COMPRESSION_THRESHOLD and the client signals support via Accept-Encoding.
 *
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse}  response
 * @param {number}               statusCode  HTTP status code to send
 * @param {unknown}              payload     Value to JSON-serialise
 */
async function sendJson(request, response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };

  if (body.length > COMPRESSION_THRESHOLD) {
    const acceptEncoding = request?.headers?.['accept-encoding'] || '';
    if (acceptEncoding.includes('gzip')) {
      const compressed = await new Promise((resolve, reject) =>
        zlib.gzip(body, (err, result) => (err ? reject(err) : resolve(result)))
      );
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

  return function checkRate(key, maxRequests, windowMs = 60_000) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetTime) {
      bucket = { count: 0, resetTime: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count > maxRequests;
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
  // Returns true if the request should be blocked
  function applyRateLimits(request, url, clientIp) {
    const method = request.method;
    const path = url.pathname;

    if (method === 'POST' && path === '/api/admin/login') {
      // Strict: 5 attempts per 15-minute window (brute-force protection)
      if (checkRate(`login:${clientIp}`, 5, 15 * 60_000)) return true;
    } else if (method === 'POST' && path === '/api/submissions') {
      // 30 submissions per minute per IP
      if (checkRate(`submit:${clientIp}`, 30)) return true;
    } else if (method === 'GET' && (path === '/api/geocode' || path === '/api/reverse-geocode')) {
      // 30 geocode requests per minute (external API cost)
      if (checkRate(`geocode:${clientIp}`, 30)) return true;
    } else if (path.startsWith('/api/admin/')) {
      // 60 admin API calls per minute
      if (checkRate(`admin:${clientIp}`, 60)) return true;
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
        response.end(JSON.stringify({ error: '요청 처리 시간이 초과되었습니다.' }));
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

    // Rate limiting
    if (applyRateLimits(request, url, clientIp)) {
      log.warn(`[RATE] rate limited (${clientIp}) ${request.method} ${url.pathname}`);
      await sendJson(request, response, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
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

        await sendJson(request, response, 201, submission);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/assignments/override') {
        if (!checkAuth(request)) {
          await sendJson(request, response, 401, { error: '인증이 필요합니다.' });
          return;
        }
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        if (!body.submissionId || !body.assignedArea) {
          throw new ValidationError('submissionId and assignedArea are required.');
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
        const submissions = await store.listSubmissions();
        const cfg = store.getConfig ? store.getConfig() : {};
        const timestamp = new Date().toISOString();
        await sendJson(request, response, 200, { timestamp, totalSubmissions: submissions.length, submissions, config: cfg });
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
        // Check current password against DB override or env config
        const dbPassword = await store.getAdminPassword();
        const currentActual = dbPassword || config.adminPassword;
        if (!await verifyPassword(body.currentPassword, currentActual)) {
          await sendJson(request, response, 401, { error: '현재 비밀번호가 틀렸어요.' });
          return;
        }
        // Store new password as scrypt hash
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

  // Pre-warm the DB and perform a basic integrity check before accepting traffic
  server._store.init().then(async () => {
    await server._store.getSubmissionCounts();
    log.info('[DB] integrity check passed');
    // Initial backup after DB is confirmed healthy
    await backupDatabase(config.dbFile);
  }).catch((err) => {
    log.error('[DB] integrity check failed:', err.message);
    process.exit(1);
  });

  // Periodic DB backup every 24h
  setInterval(() => backupDatabase(config.dbFile), BACKUP_INTERVAL_MS).unref();

  server.listen(config.port, host, () => {
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
  });

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

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
