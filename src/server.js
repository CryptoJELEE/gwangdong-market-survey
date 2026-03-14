import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { assignArea, assignAreaByDistance } from './assignment.js';
import { createGeocoder } from './geocoding.js';
import { SurveyStore } from './storage/index.js';
import { collectJsonBody, json } from './utils.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_PHOTO_BYTES = 500 * 1024; // 500 KB

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

function validateSubmission(body, config) {
  const required = [
    body.researcher?.name,
    body.researcher?.residenceArea,
    body.survey?.region,
    body.survey?.storeType,
    body.survey?.storeName
  ];
  if (required.some((item) => !item)) {
    throw new Error('Missing required submission fields.');
  }

  // Input length validation
  const researcherName = String(body.researcher.name).trim();
  const storeName = String(body.survey.storeName).trim();
  const region = String(body.survey.region).trim();
  const notes = String(body.notes || '').trim();

  if (researcherName.length > 50) throw new Error('researcherName은 최대 50자입니다.');
  if (storeName.length > 100) throw new Error('storeName은 최대 100자입니다.');
  if (region.length > 200) throw new Error('region은 최대 200자입니다.');
  if (notes.length > 2000) throw new Error('notes는 최대 2000자입니다.');

  // Photo size validation
  const photoDataUrl = String(body.photoDataUrl || '').trim();
  if (photoDataUrl.length > 0) {
    const base64Part = photoDataUrl.includes(',') ? photoDataUrl.split(',')[1] : photoDataUrl;
    const estimatedBytes = Math.ceil(base64Part.length * 3 / 4);
    if (estimatedBytes > MAX_PHOTO_BYTES) throw new Error('사진은 최대 500KB입니다.');
  }

  const prices = (body.prices || []).filter((item) => item.price !== '' && item.price !== null && item.price !== undefined);

  // Price validation
  for (const item of prices) {
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 0 || price > 999999) {
      throw new Error('가격은 0~999999 범위의 숫자여야 합니다.');
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

async function serveStatic(response, filePath) {
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
  const cacheHeaders = { 'Content-Type': contentTypes[extension] || 'application/octet-stream', 'ETag': etag };

  if (extension === '.html') {
    cacheHeaders['Cache-Control'] = 'no-cache';
  } else if (extension === '.css' || extension === '.js' || extension === '.json') {
    cacheHeaders['Cache-Control'] = 'public, max-age=3600';
  } else {
    cacheHeaders['Cache-Control'] = 'public, max-age=86400';
  }

  response.writeHead(200, cacheHeaders);
  response.end(contents);
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Max-Age', '86400');
}

export async function closeApp(server) {
  if (!server) return;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
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

  const server = http.createServer(async (request, response) => {
    const clientIp = getClientIp(request);
    const url = new URL(request.url, `http://${request.headers.host}`);

    // Request logging
    console.log(`[${request.method}] ${url.pathname} (${clientIp})`);

    setCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    // Rate limiting
    const isSubmissionPost = request.method === 'POST' && url.pathname === '/api/submissions';
    const isAdminLogin = request.method === 'POST' && url.pathname === '/api/admin/login';

    if (isAdminLogin && checkRate(`login:${clientIp}`, 5)) {
      console.warn(`[RATE] 429 - login rate exceeded (${clientIp})`);
      json(response, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
      return;
    }
    if (isSubmissionPost && checkRate(`submit:${clientIp}`, 10)) {
      console.warn(`[RATE] 429 - submission rate exceeded (${clientIp})`);
      json(response, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
      return;
    }
    if (checkRate(`global:${clientIp}`, 60)) {
      console.warn(`[RATE] 429 - global rate exceeded (${clientIp})`);
      json(response, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
      return;
    }

    try {
      if (!initialized) {
        await store.init();
        initialized = true;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        await serveStatic(response, path.resolve('src/client/index.html'));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        await serveStatic(response, path.resolve('src/client/app.js'));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/styles.css') {
        await serveStatic(response, path.resolve('src/client/styles.css'));
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico')) {
        await serveStatic(response, path.resolve('src/client/favicon.svg'));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/manifest.json') {
        await serveStatic(response, path.resolve('src/client/manifest.json'));
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
        await serveStatic(response, path.resolve('src/client', url.pathname.slice(1)));
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        await serveStatic(response, path.resolve(config.uploadsDir, url.pathname.replace('/uploads/', '')));
        return;
      }

      // ── Admin page static files ──
      if (request.method === 'GET' && url.pathname === '/admin') {
        await serveStatic(response, path.resolve('src/client/admin.html'));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/admin.js') {
        await serveStatic(response, path.resolve('src/client/admin.js'));
        return;
      }

      // ── Admin auth endpoints ──
      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        if (body.password === config.adminPassword) {
          json(response, 200, { token: createAdminToken() });
        } else {
          json(response, 401, { error: '비밀번호가 틀렸어요.' });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/verify') {
        if (checkAuth(request)) {
          json(response, 200, { ok: true });
        } else {
          json(response, 401, { error: 'Unauthorized' });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/submissions') {
        if (!checkAuth(request)) {
          json(response, 401, { error: 'Unauthorized' });
          return;
        }
        const submissions = await store.listSubmissions();
        json(response, 200, submissions);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/settings') {
        if (!checkAuth(request)) {
          json(response, 401, { error: 'Unauthorized' });
          return;
        }
        const [customAreas, customProducts, customStoreTypes] = await Promise.all([
          store.getSetting('customAreas'),
          store.getSetting('customProducts'),
          store.getSetting('customStoreTypes')
        ]);
        json(response, 200, { customAreas, customProducts, customStoreTypes });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/settings') {
        if (!checkAuth(request)) {
          json(response, 401, { error: 'Unauthorized' });
          return;
        }
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        const allowedKeys = ['customAreas', 'customProducts', 'customStoreTypes'];
        if (!body.key || !allowedKeys.includes(body.key)) {
          json(response, 400, { error: 'Invalid setting key.' });
          return;
        }
        if (!Array.isArray(body.value)) {
          json(response, 400, { error: 'Value must be an array.' });
          return;
        }
        await store.setSetting(body.key, body.value);
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/daily-summary') {
        const dateParam = url.searchParams.get('date');
        const targetDate = dateParam || new Date().toISOString().slice(0, 10);
        const submissions = await store.listSubmissions();
        const daySubs = submissions.filter((s) => {
          const d = new Date(s.createdAt);
          const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return ymd === targetDate;
        });

        const totalSubmissions = daySubs.length;
        const researcherSet = new Set(daySubs.map((s) => s.researcher.name));
        const uniqueResearchers = researcherSet.size;
        const areaSet = new Set(daySubs.map((s) => s.assignment?.currentArea).filter(Boolean));
        const areasCovered = areaSet.size;

        // Average prices per product (today only)
        const priceMap = {};
        daySubs.forEach((s) => {
          if (!s.prices) return;
          s.prices.forEach((p) => {
            const key = `${p.productLabel || p.productId}|${p.size}`;
            if (!priceMap[key]) priceMap[key] = { label: p.productLabel || p.productId, size: p.size, prices: [] };
            const num = Number(String(p.price).replace(/[^0-9]/g, ''));
            if (num > 0) priceMap[key].prices.push(num);
          });
        });
        const averagePrices = Object.values(priceMap)
          .filter((v) => v.prices.length > 0)
          .map((v) => ({
            label: v.label,
            size: v.size,
            avg: Math.round(v.prices.reduce((a, b) => a + b, 0) / v.prices.length),
            count: v.prices.length
          }));

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

        json(response, 200, { date: targetDate, totalSubmissions, uniqueResearchers, areasCovered, averagePrices, topResearcher, topStore });
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
        json(response, 200, {
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
        json(response, 200, result);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/reverse-geocode') {
        const lat = url.searchParams.get('lat');
        const lng = url.searchParams.get('lng');
        if (!lat || !lng) {
          json(response, 400, { error: 'lat and lng are required.' });
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
        json(response, 200, { address, lat: Number(lat), lng: Number(lng) });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/survey-stats') {
        const customAreas = await store.getSetting('customAreas');
        const activeAreas = customAreas || config.areas;
        const submissionCounts = await store.getSubmissionCounts();
        const areaCoordinates = await geocodeAreas(activeAreas);
        json(response, 200, {
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

        const submission = await store.createSubmission({
          ...payload,
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
        json(response, 201, submission);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/assignments/override') {
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        if (!body.submissionId || !body.assignedArea) {
          throw new Error('submissionId and assignedArea are required.');
        }
        const updated = await store.overrideAssignment({
          submissionId: body.submissionId,
          assignedArea: body.assignedArea,
          reason: body.reason || '',
          adminName: body.adminName || 'Admin'
        });
        json(response, 200, updated);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/backup') {
        if (!checkAuth(request)) {
          json(response, 401, { error: 'Unauthorized' });
          return;
        }
        const submissions = await store.listSubmissions();
        const cfg = store.getConfig ? store.getConfig() : {};
        const timestamp = new Date().toISOString();
        json(response, 200, { timestamp, totalSubmissions: submissions.length, submissions, config: cfg });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/submissions/delete') {
        if (!checkAuth(request)) {
          json(response, 401, { error: 'Unauthorized' });
          return;
        }
        const body = await collectJsonBody(request, MAX_BODY_BYTES);
        if (!body.submissionId) throw new Error('submissionId is required.');
        await store.deleteSubmission(body.submissionId);
        json(response, 200, { ok: true });
        return;
      }

      json(response, 404, { error: 'Not found' });
    } catch (error) {
      console.warn(`[400] ${request.method} ${url.pathname} (${clientIp}): ${error.message}`);
      console.error(error.stack);
      json(response, 400, { error: error.message });
    }
  });

  server._store = store;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  const server = createApp(config);
  const host = '0.0.0.0';

  server.listen(config.port, host, () => {
    console.log(`Market survey app running at http://${host}:${config.port}`);
  });

  function shutdown(signal) {
    console.log(`
${signal} received - shutting down gracefully...`);
    closeApp(server).then(() => {
      console.log('Server closed.');
      process.exit(0);
    }).catch((error) => {
      console.error('Graceful shutdown failed.', error);
      process.exit(1);
    });
    setTimeout(() => {
      console.error('Forceful shutdown after timeout.');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
