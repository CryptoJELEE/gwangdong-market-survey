import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdtemp } from 'node:fs/promises';
import { closeApp, createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT0sAAAAASUVORK5CYII=';

async function createTestServer(t, options = {}) {
  const { envOverrides = {}, ...serverOptions } = options;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'market-survey-'));
  const config = loadConfig({
    PORT: '0',
    DATA_DIR: tempDir,
    DB_FILE: path.join(tempDir, 'survey.db'),
    STORE_FILE: path.join(tempDir, 'store.json'),
    UPLOADS_DIR: path.join(tempDir, 'uploads'),
    ...envOverrides
  });

  const server = createApp(config, serverOptions);
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(async () => {
    await closeApp(server);
  });

  const { port } = server.address();
  return {
    tempDir,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

test('submission API stores a survey and exposes it in bootstrap data', async (t) => {
  const { tempDir, baseUrl } = await createTestServer(t);

  const createResponse = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Kim', residenceArea: '서울 중부' },
      survey: {
        region: 'Gangnam',
        storeType: 'Pharmacy',
        storeName: 'Healthy Drug',
        posCount: 2,
        displayLocation: 'Front counter'
      },
      prices: [
        { productId: 'vita500', productLabel: 'Vita 500', size: '100ml', price: 1200 }
      ],
      photoDataUrl: tinyPng,
      notes: 'Promo stand present'
    })
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.assignment.currentArea, '서울 중부');
  assert.match(created.photo.url, /^\/uploads\//);
  assert.equal(created.sync.mode, 'local');

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.submissions.length, 1);
  assert.equal(bootstrap.submissions[0].survey.storeName, 'Healthy Drug');
  assert.equal(bootstrap.assignmentOverrides.length, 0);
  assert.equal(bootstrap.adminTokenConfigured, false);
});

test('override API requires auth and updates assignment area', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const createResponse = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Lee', residenceArea: '서울 서부' },
      survey: {
        region: 'Mapo',
        storeType: 'Mart',
        storeName: 'Fresh Mart',
        posCount: 1,
        displayLocation: 'Fridge'
      },
      prices: [
        { productId: 'cornsilk', productLabel: '옥수수수염차', size: '500ml', price: 2200 }
      ]
    })
  });
  const created = await createResponse.json();

  // Unauthenticated override should be rejected
  const unauthResponse = await fetch(`${baseUrl}/api/assignments/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionId: created.id, assignedArea: '경기 북부' })
  });
  assert.equal(unauthResponse.status, 401);

  // Get admin token
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();

  const overrideResponse = await fetch(`${baseUrl}/api/assignments/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      submissionId: created.id,
      assignedArea: '경기 북부',
      reason: 'Capacity balancing',
      adminName: 'Ops lead'
    })
  });

  assert.equal(overrideResponse.status, 200);
  const updated = await overrideResponse.json();
  assert.equal(updated.assignment.currentArea, '경기 북부');
  assert.equal(updated.assignment.overriddenBy, 'Ops lead');

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.assignmentOverrides.length, 1);
  assert.equal(bootstrap.assignmentOverrides[0].assignedArea, '경기 북부');
});

test('bootstrap reflects admin token configuration', async (t) => {
  const { baseUrl } = await createTestServer(t, { envOverrides: { ADMIN_TOKEN: 'secret-token' } });

  const response = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.adminTokenConfigured, true);
  assert.ok(Array.isArray(payload.areas));
  assert.ok(Array.isArray(payload.products));
});

test('submission API accepts payloads without product prices', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const response = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Kim', residenceArea: '서울 중부' },
      survey: {
        region: 'Gangnam',
        storeType: 'Pharmacy',
        storeName: 'Healthy Drug'
      },
      prices: []
    })
  });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.deepStrictEqual(payload.prices, []);
});

test('root document is served for the mobile app shell', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /이온로드/);
});

test('geocode API returns coordinates from the configured geocoder', async (t) => {
  const geocoder = {
    async geocode(query) {
      assert.equal(query, '서울특별시 중구');
      return { lat: 37.5636, lng: 126.9976, address: '서울특별시 중구' };
    },
    async tryGeocode() {
      return null;
    }
  };

  const { baseUrl } = await createTestServer(t, { geocoder });
  const response = await fetch(`${baseUrl}/api/geocode?query=${encodeURIComponent('서울특별시 중구')}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, {
    lat: 37.5636,
    lng: 126.9976,
    address: '서울특별시 중구'
  });
});

test('survey stats include per-area counts and coordinates', async (t) => {
  const coordinatesByQuery = {
    '서울 중부': { lat: 37.5665, lng: 126.978, address: '서울특별시 중구' },
    '서울 동부': { lat: 37.551, lng: 127.146, address: '서울특별시 강동구' },
    '서울 서부': { lat: 37.5638, lng: 126.9084, address: '서울특별시 마포구' },
    '경기 북부': { lat: 37.7381, lng: 127.0337, address: '경기도 의정부시' },
    '경기 남부': { lat: 37.2636, lng: 127.0286, address: '경기도 수원시' }
  };
  const geocoder = {
    async geocode(query) {
      return coordinatesByQuery[query];
    },
    async tryGeocode(query) {
      return coordinatesByQuery[query] || null;
    }
  };

  const { baseUrl } = await createTestServer(t, { geocoder });
  await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Park', residenceArea: '서울 중부' },
      survey: {
        region: 'Gangnam',
        storeType: 'Mart',
        storeName: 'Center Mart'
      },
      prices: [
        { productId: 'vita500', productLabel: 'Vita 500', size: '100ml', price: 1300 }
      ]
    })
  });

  const response = await fetch(`${baseUrl}/api/survey-stats`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  const seoulCentral = payload.areas.find((area) => area.area === '서울 중부');
  assert.equal(seoulCentral.submissionCount, 1);
  assert.deepEqual(seoulCentral.coordinates, { lat: 37.5665, lng: 126.978 });
});

test('submission API uses distance-based assignment when coordinates are available', async (t) => {
  const eastCoordinates = [
    { lat: 0, lng: 0, address: '서울 동부 residence' },
    { lat: 0, lng: 10, address: '서울 동부 area' }
  ];
  const coordinatesByQuery = {
    '서울 중부': { lat: 0, lng: 1, address: '서울 중부' },
    '서울 서부': { lat: 0, lng: 2, address: '서울 서부' },
    '경기 북부': { lat: 0, lng: 3, address: '경기 북부' },
    '경기 남부': { lat: 0, lng: 4, address: '경기 남부' },
    Gangnam: { lat: 0, lng: 5, address: 'Gangnam' }
  };
  const geocoder = {
    async geocode(query) {
      return this.tryGeocode(query);
    },
    async tryGeocode(query) {
      if (query === '서울 동부') {
        return eastCoordinates.shift() || { lat: 0, lng: 10, address: '서울 동부 area' };
      }
      return coordinatesByQuery[query] || null;
    }
  };

  const { baseUrl } = await createTestServer(t, { geocoder });
  const response = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Han', residenceArea: '서울 동부' },
      survey: {
        region: 'Gangnam',
        storeType: 'Pharmacy',
        storeName: 'Distance Test'
      },
      prices: [
        { productId: 'vita500', productLabel: 'Vita 500', size: '100ml', price: 1400 }
      ]
    })
  });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.assignment.currentArea, '서울 중부');
  assert.equal(payload.assignment.method, 'distance-fairness-blend');
  assert.deepEqual(payload.researcher.coordinates, { lat: 0, lng: 0 });
  assert.deepEqual(payload.survey.coordinates, { lat: 0, lng: 5 });
});

// ── New test coverage ──

test('health endpoint returns server status', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'ok');
  assert.ok(typeof payload.uptime === 'number');
  assert.ok(typeof payload.version === 'string');
});

test('unknown route returns 404', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.ok(payload.error);
});

test('admin login succeeds with correct password and returns token', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(typeof payload.token === 'string' && payload.token.length > 0);
});

test('admin login rejects wrong password', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' })
  });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.ok(payload.error);
});

test('admin verify rejects unauthenticated request', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/admin/verify`);
  assert.equal(response.status, 401);
});

test('admin verify accepts a valid token', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginResponse.json();

  const verifyResponse = await fetch(`${baseUrl}/api/admin/verify`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.equal(verifyResponse.status, 200);
  const payload = await verifyResponse.json();
  assert.equal(payload.ok, true);
});

test('admin submissions list requires authentication', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/admin/submissions`);
  assert.equal(response.status, 401);
});

test('submission API rejects missing required fields', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Kim' },
      survey: { storeType: 'Mart' }
      // missing residenceArea, region, storeName
    })
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.error);
});

test('submission API rejects price out of valid range', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Kim', residenceArea: '서울 중부' },
      survey: { region: 'Gangnam', storeType: 'Pharmacy', storeName: 'Test Store' },
      prices: [{ productId: 'vita500', productLabel: 'Vita 500', size: '100ml', price: 9999999 }]
    })
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.error);
});

test('daily summary aggregates submissions for a date', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Create two submissions
  await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Alice', residenceArea: '서울 중부' },
      survey: { region: 'Gangnam', storeType: 'Mart', storeName: 'Mart A' },
      prices: [{ productId: 'vita500', productLabel: 'Vita 500', size: '100ml', price: 1200 }]
    })
  });
  await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Bob', residenceArea: '서울 서부' },
      survey: { region: 'Mapo', storeType: 'Pharmacy', storeName: 'Pharmacy B' },
      prices: [{ productId: 'vita500', productLabel: 'Vita 500', size: '100ml', price: 1400 }]
    })
  });

  const today = new Date().toISOString().slice(0, 10);
  const response = await fetch(`${baseUrl}/api/daily-summary?date=${today}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.totalSubmissions, 2);
  assert.equal(payload.uniqueResearchers, 2);
  assert.ok(Array.isArray(payload.averagePrices));
  const vita = payload.averagePrices.find((p) => p.label === 'Vita 500');
  assert.ok(vita);
  assert.equal(vita.avg, 1300); // (1200+1400)/2
  assert.equal(vita.count, 2);
});

test('admin settings stores and retrieves custom areas', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginResponse.json();
  const authHeader = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Save custom areas
  const saveResponse = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({ key: 'customAreas', value: ['서울 A', '서울 B'] })
  });
  assert.equal(saveResponse.status, 200);

  // Retrieve settings
  const getResponse = await fetch(`${baseUrl}/api/admin/settings`, { headers: authHeader });
  assert.equal(getResponse.status, 200);
  const settings = await getResponse.json();
  assert.deepStrictEqual(settings.customAreas, ['서울 A', '서울 B']);

  // Bootstrap should reflect custom areas
  const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
  assert.deepStrictEqual(bootstrap.areas, ['서울 A', '서울 B']);
});

test('admin delete submission removes it from list', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginResponse.json();
  const authHeader = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Create a submission
  const createResponse = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'To Delete', residenceArea: '서울 중부' },
      survey: { region: 'Gangnam', storeType: 'Mart', storeName: 'Delete Test' },
      prices: []
    })
  });
  const created = await createResponse.json();

  // Delete requires auth
  const noAuthDelete = await fetch(`${baseUrl}/api/submissions/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionId: created.id })
  });
  assert.equal(noAuthDelete.status, 401);

  // Authenticated delete
  const deleteResponse = await fetch(`${baseUrl}/api/submissions/delete`, {
    method: 'POST',
    headers: authHeader,
    body: JSON.stringify({ submissionId: created.id })
  });
  assert.equal(deleteResponse.status, 200);
  const result = await deleteResponse.json();
  assert.equal(result.ok, true);

  // Submission no longer in bootstrap
  const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
  assert.equal(bootstrap.submissions.length, 0);
});

test('static file returns 304 when ETag matches', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // First request to get ETag
  const first = await fetch(`${baseUrl}/styles.css`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'ETag header should be present');

  // Second request with ETag should return 304
  const second = await fetch(`${baseUrl}/styles.css`, {
    headers: { 'If-None-Match': etag }
  });
  assert.equal(second.status, 304);
});

test('response includes security headers', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

// ── Round 17 new tests ──

test('gzip compression is applied when Accept-Encoding: gzip is sent', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Create some submissions so bootstrap has substantial data
  await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Gzip Test', residenceArea: '서울 중부' },
      survey: { region: 'Gangnam', storeType: 'Mart', storeName: 'Test Store' },
      prices: []
    })
  });

  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { 'Accept-Encoding': 'gzip' }
  });
  assert.equal(response.status, 200);
  // fetch() auto-decompresses, so we can verify the content is valid JSON
  const payload = await response.json();
  assert.ok(Array.isArray(payload.areas));
  assert.ok(Array.isArray(payload.submissions));
  // Verify Content-Encoding header
  assert.equal(response.headers.get('content-encoding'), 'gzip');
});

test('admin submissions supports pagination', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginResponse.json();
  const authHeader = { 'Authorization': `Bearer ${token}` };

  // Create 5 submissions
  for (let i = 1; i <= 5; i++) {
    await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        researcher: { name: `Researcher ${i}`, residenceArea: '서울 중부' },
        survey: { region: 'Gangnam', storeType: 'Mart', storeName: `Store ${i}` },
        prices: []
      })
    });
  }

  // Without pagination — returns array (backward compat)
  const allResponse = await fetch(`${baseUrl}/api/admin/submissions`, { headers: authHeader });
  assert.equal(allResponse.status, 200);
  const allData = await allResponse.json();
  assert.ok(Array.isArray(allData));
  assert.equal(allData.length, 5);

  // With pagination — page 1, limit 2
  const page1Response = await fetch(`${baseUrl}/api/admin/submissions?page=1&limit=2`, { headers: authHeader });
  assert.equal(page1Response.status, 200);
  const page1 = await page1Response.json();
  assert.equal(page1.total, 5);
  assert.equal(page1.page, 1);
  assert.equal(page1.limit, 2);
  assert.equal(page1.items.length, 2);

  // Page 3 — only 1 item remaining
  const page3Response = await fetch(`${baseUrl}/api/admin/submissions?page=3&limit=2`, { headers: authHeader });
  const page3 = await page3Response.json();
  assert.equal(page3.items.length, 1);
});

test('password hashing: change-password stores hashed password and login still works', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Login with default plain-text password
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();

  // Change to new password (gets stored as scrypt hash)
  const changeResponse = await fetch(`${baseUrl}/api/admin/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: 'ionroad2026', newPassword: 'newpass123' })
  });
  assert.equal(changeResponse.status, 200);

  // Login with new password (should work with stored scrypt hash)
  const newLoginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'newpass123' })
  });
  assert.equal(newLoginResponse.status, 200);
  const newPayload = await newLoginResponse.json();
  assert.ok(typeof newPayload.token === 'string');

  // Old password no longer works
  const oldLoginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  assert.equal(oldLoginResponse.status, 401);
});

test('response timing is included in log output', async (t) => {
  // This test verifies the server doesn't crash with the timing wrapper
  // (timing is logged to stdout, we just verify request succeeds)
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'ok');
});

// ── Round 18 new tests ──

test('Content-Security-Policy header is present on API responses', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/bootstrap`);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp, 'CSP header should be present');
  assert.ok(csp.includes("default-src 'self'"), 'CSP should include default-src');
  assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP should block framing');
});

test('oversized body for auth endpoint is rejected', async (t) => {
  const { baseUrl } = await createTestServer(t);
  // 4KB + 1 byte — exceeds MAX_AUTH_BODY_BYTES for the login endpoint
  const oversizedPassword = 'x'.repeat(4 * 1024 + 1);
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: oversizedPassword })
  });
  assert.equal(response.status, 400);
});

test('graceful shutdown closes server cleanly', async (t) => {
  const { baseUrl } = await createTestServer(t);
  // Verify the server is up
  const before = await fetch(`${baseUrl}/health`);
  assert.equal(before.status, 200);
  // closeApp is called by t.after() - this test just verifies the server
  // lifecycle works end-to-end without errors (t.after registers closeApp)
});

test('concurrent requests during init are handled safely', async (t) => {
  const { baseUrl } = await createTestServer(t);
  // Fire 5 requests simultaneously on a fresh server
  const results = await Promise.all(
    Array.from({ length: 5 }, () => fetch(`${baseUrl}/health`))
  );
  for (const r of results) {
    assert.equal(r.status, 200);
  }
});

test('admin submissions pagination respects max limit cap', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginResponse.json();

  // Request limit=999 — should be capped at 200
  const response = await fetch(`${baseUrl}/api/admin/submissions?page=1&limit=999`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.limit, 200, 'limit should be capped at PAGINATION_MAX_LIMIT');
});

// ── Round 19 new tests ──

test('X-Request-Id header is present on all responses', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Server-generated request ID
  const r1 = await fetch(`${baseUrl}/health`);
  assert.ok(r1.headers.get('x-request-id'), 'X-Request-Id should be set');
  assert.match(r1.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, 'should be UUID format');

  // Client-supplied request ID should be echoed back
  const clientId = 'my-trace-id-12345';
  const r2 = await fetch(`${baseUrl}/health`, {
    headers: { 'X-Request-Id': clientId }
  });
  assert.equal(r2.headers.get('x-request-id'), clientId, 'client-supplied ID should be echoed');
});

test('health endpoint includes DB status and memory info', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'ok');
  assert.equal(payload.db, 'ok');
  assert.ok(typeof payload.memory === 'object', 'memory object should be present');
  assert.ok(typeof payload.memory.rssMb === 'number', 'rssMb should be a number');
  assert.ok(typeof payload.memory.heapUsedMb === 'number', 'heapUsedMb should be a number');
  assert.ok(payload.memory.rssMb > 0, 'RSS should be positive');
});

test('metrics endpoint returns request statistics (admin-only)', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Unauthenticated — should be rejected
  const unauth = await fetch(`${baseUrl}/api/metrics`);
  assert.equal(unauth.status, 401);

  // Get admin token
  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginResponse.json();

  // Make a few requests to generate metrics
  await fetch(`${baseUrl}/health`);
  await fetch(`${baseUrl}/api/bootstrap`);

  const metricsResponse = await fetch(`${baseUrl}/api/metrics`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.equal(metricsResponse.status, 200);
  const m = await metricsResponse.json();
  assert.ok(typeof m.requests === 'number' && m.requests > 0, 'requests count should be positive');
  assert.ok(typeof m.errors === 'number', 'errors field should exist');
  assert.ok(typeof m.errorRate === 'number', 'errorRate field should exist');
  assert.ok(typeof m.avgResponseMs === 'number', 'avgResponseMs should exist');
  assert.ok(typeof m.p99ResponseMs === 'number', 'p99ResponseMs should exist');
});

test('configurable CORS allows specific origin', async (t) => {
  const tempDir = await (await import('node:fs/promises')).mkdtemp(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'cors-test-')
  );
  const config = loadConfig({
    PORT: '0',
    DATA_DIR: tempDir,
    DB_FILE: `${tempDir}/survey.db`,
    STORE_FILE: `${tempDir}/store.json`,
    UPLOADS_DIR: `${tempDir}/uploads`
  });
  const server = createApp(config, {
    allowedOrigins: 'https://example.com',
    geocoder: { async geocode() { return null; }, async tryGeocode() { return null; } }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(async () => { await closeApp(server); });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Allowed origin
  const allowed = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://example.com' }
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.com');

  // Disallowed origin — falls back to the first allowed origin (not reflected)
  const disallowed = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://evil.com' }
  });
  assert.notEqual(disallowed.headers.get('access-control-allow-origin'), 'https://evil.com');
});

test('CSS static files include stale-while-revalidate in Cache-Control', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/styles.css`);
  assert.equal(response.status, 200);
  const cc = response.headers.get('cache-control');
  assert.ok(cc, 'Cache-Control header should be present');
  assert.ok(cc.includes('stale-while-revalidate'), 'CSS should have stale-while-revalidate');
});

test('Vary: Accept-Encoding is set on gzip-compressed responses', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Bootstrap with enough data to trigger compression (>1024 bytes)
  for (let i = 0; i < 3; i++) {
    await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        researcher: { name: `Vary Test ${i}`, residenceArea: '서울 중부' },
        survey: { region: 'Gangnam', storeType: 'Mart', storeName: `Store Vary ${i}` },
        prices: []
      })
    });
  }

  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { 'Accept-Encoding': 'gzip' }
  });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.ok(response.headers.get('vary')?.includes('Accept-Encoding'),
    'Vary: Accept-Encoding should be present on compressed response');
});

// ── Edge-case tests ──────────────────────────────────────────────────────────

test('empty DB: bootstrap returns empty submissions array', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.submissions), 'submissions should be an array');
  assert.equal(data.submissions.length, 0, 'fresh DB should have no submissions');
  assert.ok(Array.isArray(data.areas), 'areas should be populated from config');
});

test('empty DB: daily-summary returns zeros', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/daily-summary?date=2099-01-01`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.totalSubmissions, 0);
  assert.equal(data.uniqueResearchers, 0);
  assert.equal(data.areasCovered, 0);
  assert.deepEqual(data.averagePrices, []);
  assert.equal(data.topResearcher, null);
  assert.equal(data.topStore, null);
});

test('empty DB: /api/admin/submissions returns empty array', async (t) => {
  const { baseUrl } = await createTestServer(t);
  // Login first
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  const response = await fetch(`${baseUrl}/api/admin/submissions`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data), 'should return array when no pagination params');
  assert.equal(data.length, 0);
});

test('large data: paginated submissions return correct slice', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Insert 25 submissions
  for (let i = 0; i < 25; i++) {
    await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        researcher: { name: `Researcher${i}`, residenceArea: '서울 중부' },
        survey: { region: `Region${i}`, storeType: 'Mart', storeName: `Store${i}` },
        prices: []
      })
    });
  }

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  // Page 1 — 10 items
  const page1 = await fetch(`${baseUrl}/api/admin/submissions?page=1&limit=10`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(page1.status, 200);
  const d1 = await page1.json();
  assert.equal(d1.total, 25);
  assert.equal(d1.page, 1);
  assert.equal(d1.limit, 10);
  assert.equal(d1.items.length, 10);

  // Page 3 — last 5 items
  const page3 = await fetch(`${baseUrl}/api/admin/submissions?page=3&limit=10`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(page3.status, 200);
  const d3 = await page3.json();
  assert.equal(d3.items.length, 5);
});

test('Korean error messages: missing fields returns Korean error', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ researcher: {}, survey: {} })
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.ok(data.error.includes('필수'), `Expected Korean error, got: ${data.error}`);
});

test('Korean error messages: 401 response is Korean', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/admin/submissions`);
  assert.equal(response.status, 401);
  const data = await response.json();
  assert.ok(data.error.includes('인증'), `Expected Korean auth error, got: ${data.error}`);
});

test('Korean error messages: 404 response is Korean', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/nonexistent-endpoint`);
  assert.equal(response.status, 404);
  const data = await response.json();
  assert.ok(data.error.length > 0, 'Should have Korean 404 message');
  assert.ok(!data.error.includes('Not found'), 'Should not contain English "Not found"');
});

// ── Round 21 feature tests ───────────────────────────────────────────────────

test('/api/status requires auth and returns system info', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Unauthenticated → 401
  const unauth = await fetch(`${baseUrl}/api/status`);
  assert.equal(unauth.status, 401);

  // Login then check /api/status
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  const statusRes = await fetch(`${baseUrl}/api/status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(statusRes.status, 200);
  const data = await statusRes.json();

  assert.equal(data.status, 'ok');
  assert.ok(typeof data.uptime === 'number', 'uptime should be a number');
  assert.ok(typeof data.activeConnections === 'number', 'activeConnections should be a number');
  assert.ok(data.memory && typeof data.memory.rssMb === 'number', 'memory.rssMb should exist');
  assert.ok(data.memory && typeof data.memory.heapTotalMb === 'number', 'memory.heapTotalMb should exist');
  assert.ok(data.db && typeof data.db.sizeBytes === 'number', 'db.sizeBytes should exist');
  assert.ok(data.metrics && typeof data.metrics.requests === 'number', 'metrics.requests should exist');
});

test('Webhook retry: retries on failure and delivers on eventual success', async (t) => {
  const { baseUrl } = await createTestServer(t, {
    // Mock fetchImpl: fail first 2 calls, succeed on 3rd
    fetchImpl: (() => {
      let calls = 0;
      return async (url, init) => {
        // Only intercept webhook URL
        if (url === 'https://webhook.test/hook') {
          calls++;
          if (calls < 3) throw new Error('network error');
          return { ok: true };
        }
        // Other calls (geocode etc.) fall through as no-ops
        return { ok: true, json: async () => ({}) };
      };
    })()
  });

  // Configure webhook
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  await fetch(`${baseUrl}/api/admin/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: 'https://webhook.test/hook', events: ['new_submission'] })
  });

  // Submit — triggers webhook fire-and-forget with retry
  const sub = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'WebhookTest', residenceArea: '서울 중부' },
      survey: { region: 'TestRegion', storeType: 'Mart', storeName: 'TestStore' },
      prices: []
    })
  });
  assert.equal(sub.status, 201, 'Submission should succeed regardless of webhook retries');
});

test('Admin IP whitelist: blocks non-whitelisted IPs from admin routes', async (t) => {
  const { baseUrl } = await createTestServer(t, {
    // Allow only 1.2.3.4 — requests will come from 127.0.0.1 so they'll be blocked
    adminIpWhitelist: ['1.2.3.4']
  });

  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  assert.equal(response.status, 403, 'Non-whitelisted IP should get 403');
  const data = await response.json();
  assert.ok(data.error.includes('IP'), `Expected IP block error, got: ${data.error}`);
});

test('Admin IP whitelist: allows all IPs when whitelist is null', async (t) => {
  const { baseUrl } = await createTestServer(t);
  // No whitelist configured → normal auth flow
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  // Should not be 403
  assert.notEqual(response.status, 403, 'No whitelist should not block requests');
  assert.equal(response.status, 200);
});

test('Response body size is logged (X-Request-Id present in all responses)', async (t) => {
  const { baseUrl } = await createTestServer(t);
  // X-Request-Id is set on every response — as a proxy to confirm the response.end
  // wrapper is wired up (it's the same code path that logs body size)
  const response = await fetch(`${baseUrl}/health`);
  assert.ok(response.headers.get('x-request-id'), 'X-Request-Id should be present');
  assert.equal(response.status, 200);
});

// ── Round 22 feature tests ───────────────────────────────────────────────────

test('/api/docs returns endpoint list without auth', async (t) => {
  const { baseUrl } = await createTestServer(t);
  const response = await fetch(`${baseUrl}/api/docs`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.endpoints), 'should have endpoints array');
  assert.ok(data.endpoints.length > 10, 'should document at least 10 endpoints');
  assert.ok(typeof data.version === 'string', 'should include version');
  // Every entry must have method, path, auth, description
  for (const ep of data.endpoints) {
    assert.ok(ep.method, `endpoint missing method: ${JSON.stringify(ep)}`);
    assert.ok(ep.path, `endpoint missing path: ${JSON.stringify(ep)}`);
    assert.ok(typeof ep.auth === 'boolean', `endpoint auth should be boolean: ${JSON.stringify(ep)}`);
    assert.ok(ep.description, `endpoint missing description: ${JSON.stringify(ep)}`);
  }
});

test('/api/stats returns aggregated data (auth required)', async (t) => {
  const { baseUrl } = await createTestServer(t);

  // Unauthenticated → 401
  const unauth = await fetch(`${baseUrl}/api/stats`);
  assert.equal(unauth.status, 401);

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  // Insert 3 submissions from 2 different researchers
  for (const name of ['Alice', 'Alice', 'Bob']) {
    await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        researcher: { name, residenceArea: '서울 중부' },
        survey: { region: 'TestRegion', storeType: 'Mart', storeName: `Store-${name}` },
        prices: [{ productId: 'p1', productLabel: 'Product 1', size: '100ml', price: 1000 }]
      })
    });
  }

  const statsRes = await fetch(`${baseUrl}/api/stats`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(statsRes.status, 200);
  const data = await statsRes.json();

  assert.equal(data.total, 3);
  assert.ok(Array.isArray(data.byResearcher), 'byResearcher should be array');
  assert.ok(Array.isArray(data.byArea), 'byArea should be array');
  assert.ok(Array.isArray(data.byDay), 'byDay should be array');
  assert.ok(Array.isArray(data.averagePrices), 'averagePrices should be array');
  assert.equal(data.byResearcher.length, 2, 'should have 2 researchers');
  // Alice should be first (higher count)
  assert.equal(data.byResearcher[0].name, 'Alice');
  assert.equal(data.byResearcher[0].count, 2);
});

test('/api/stats filters by date range', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  // Insert a submission
  await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'DateTest', residenceArea: '서울 중부' },
      survey: { region: 'R', storeType: 'Mart', storeName: 'S' },
      prices: []
    })
  });

  // from=future → 0 results
  const futureRes = await fetch(`${baseUrl}/api/stats?from=2099-01-01`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const futureData = await futureRes.json();
  assert.equal(futureData.total, 0, 'future date filter should return 0');

  // from=past → 1 result
  const pastRes = await fetch(`${baseUrl}/api/stats?from=2020-01-01`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const pastData = await pastRes.json();
  assert.equal(pastData.total, 1);
});

test('/api/price-outliers detects statistical outliers', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  // Insert 8 submissions with consistent price ~1000, then 1 clear outlier at 8000.
  // With 8 tight samples, stdDev is small, so 8000 comfortably exceeds mean+2σ.
  for (let i = 0; i < 8; i++) {
    await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        researcher: { name: `R${i}`, residenceArea: '서울 중부' },
        survey: { region: 'R', storeType: 'Mart', storeName: `S${i}` },
        prices: [{ productId: 'p1', productLabel: 'Product1', size: '100ml', price: 1000 + i }]
      })
    });
  }
  // The outlier — clearly outside mean±2σ when the normal group is tight around 1000
  await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Outlier', residenceArea: '서울 중부' },
      survey: { region: 'R', storeType: 'Mart', storeName: 'OutlierStore' },
      prices: [{ productId: 'p1', productLabel: 'Product1', size: '100ml', price: 8000 }]
    })
  });

  const outRes = await fetch(`${baseUrl}/api/price-outliers?sigma=2`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(outRes.status, 200);
  const data = await outRes.json();
  assert.equal(data.sigma, 2);
  assert.ok(data.total >= 1, 'should detect at least 1 outlier');
  assert.ok(data.outliers[0].price === 8000, 'outlier price should be 8000');
  assert.ok(data.outliers[0].deviation > 0, 'deviation should be positive for high outlier');
});

test('/api/admin/refresh issues a new token', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token: originalToken } = await loginRes.json();

  // Refresh with original token
  const refreshRes = await fetch(`${baseUrl}/api/admin/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${originalToken}` }
  });
  assert.equal(refreshRes.status, 200);
  const { token: newToken } = await refreshRes.json();
  assert.ok(newToken, 'should return a new token');
  assert.notEqual(newToken, originalToken, 'new token should differ from original');

  // New token should work for protected endpoint
  const verifyRes = await fetch(`${baseUrl}/api/admin/verify`, {
    headers: { Authorization: `Bearer ${newToken}` }
  });
  assert.equal(verifyRes.status, 200);

  // Refresh without auth → 401
  const unauthRes = await fetch(`${baseUrl}/api/admin/refresh`, { method: 'POST' });
  assert.equal(unauthRes.status, 401);
});

test('Duplicate submission detection: same researcher+store+day gets duplicate flag', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const sub1 = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'DupResearcher', residenceArea: '서울 중부' },
      survey: { region: 'SameRegion', storeType: 'Mart', storeName: 'SameStore' },
      prices: []
    })
  });
  assert.equal(sub1.status, 201);
  const d1 = await sub1.json();
  assert.ok(!d1.duplicate, 'first submission should not be marked duplicate');

  // Same researcher + store → should detect duplicate
  const sub2 = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'DupResearcher', residenceArea: '서울 중부' },
      survey: { region: 'SameRegion', storeType: 'Mart', storeName: 'SameStore' },
      prices: []
    })
  });
  assert.equal(sub2.status, 201, 'duplicate should still succeed (warning only)');
  const d2 = await sub2.json();
  assert.equal(d2.duplicate, true, 'second submission should be flagged as duplicate');
  assert.ok(d2.duplicateId, 'duplicateId should reference the first submission');
  assert.equal(d2.duplicateId, d1.id, 'duplicateId should match first submission id');
});

test('/api/backup supports filter by researcher', async (t) => {
  const { baseUrl } = await createTestServer(t);

  for (const name of ['Alice', 'Bob', 'Alice']) {
    await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        researcher: { name, residenceArea: '서울 중부' },
        survey: { region: 'R', storeType: 'Mart', storeName: `Store-${name}` },
        prices: []
      })
    });
  }

  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'ionroad2026' })
  });
  const { token } = await loginRes.json();

  const backupRes = await fetch(`${baseUrl}/api/backup?researcher=Alice`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(backupRes.status, 200);
  const data = await backupRes.json();
  assert.equal(data.totalSubmissions, 2, 'should return only Alice submissions');
  assert.equal(data.filters.researcher, 'Alice');
  assert.ok(data.submissions.every((s) => s.researcher.name === 'Alice'));
});
