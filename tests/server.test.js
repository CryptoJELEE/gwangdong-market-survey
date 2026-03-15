import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { closeApp, createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT0sAAAAASUVORK5CYII=';

async function createTestServer(t, options = {}) {
  const { envOverrides = {}, geocoder } = options;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'market-survey-'));
  const config = loadConfig({
    PORT: '0',
    DATA_DIR: tempDir,
    DB_FILE: path.join(tempDir, 'survey.db'),
    STORE_FILE: path.join(tempDir, 'store.json'),
    UPLOADS_DIR: path.join(tempDir, 'uploads'),
    ...envOverrides
  });

  const server = createApp(config, { geocoder });
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
