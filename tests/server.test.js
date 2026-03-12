import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createApp } from '../src/server.js';
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
  t.after(() => {
    if (server._store?.close) server._store.close();
    server.close();
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
      researcher: { name: 'Kim', residenceArea: 'Seoul Central' },
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
  assert.equal(created.assignment.currentArea, 'Seoul Central');
  assert.match(created.photo.url, /^\/uploads\//);
  assert.equal(created.sync.mode, 'local');

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.submissions.length, 1);
  assert.equal(bootstrap.submissions[0].survey.storeName, 'Healthy Drug');
  assert.equal(bootstrap.assignmentOverrides.length, 0);
  assert.equal(bootstrap.adminTokenConfigured, false);
});

test('override API updates assignment area', async (t) => {
  const { baseUrl } = await createTestServer(t);

  const createResponse = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Lee', residenceArea: 'Seoul West' },
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

  const overrideResponse = await fetch(`${baseUrl}/api/assignments/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      submissionId: created.id,
      assignedArea: 'Gyeonggi North',
      reason: 'Capacity balancing',
      adminName: 'Ops lead'
    })
  });

  assert.equal(overrideResponse.status, 200);
  const updated = await overrideResponse.json();
  assert.equal(updated.assignment.currentArea, 'Gyeonggi North');
  assert.equal(updated.assignment.overriddenBy, 'Ops lead');

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.assignmentOverrides.length, 1);
  assert.equal(bootstrap.assignmentOverrides[0].assignedArea, 'Gyeonggi North');
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
      researcher: { name: 'Kim', residenceArea: 'Seoul Central' },
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
    'Seoul Central': { lat: 37.5665, lng: 126.978, address: '서울특별시 중구' },
    'Seoul East': { lat: 37.551, lng: 127.146, address: '서울특별시 강동구' },
    'Seoul West': { lat: 37.5638, lng: 126.9084, address: '서울특별시 마포구' },
    'Gyeonggi North': { lat: 37.7381, lng: 127.0337, address: '경기도 의정부시' },
    'Gyeonggi South': { lat: 37.2636, lng: 127.0286, address: '경기도 수원시' }
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
      researcher: { name: 'Park', residenceArea: 'Seoul Central' },
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
  const seoulCentral = payload.areas.find((area) => area.area === 'Seoul Central');
  assert.equal(seoulCentral.submissionCount, 1);
  assert.deepEqual(seoulCentral.coordinates, { lat: 37.5665, lng: 126.978 });
});

test('submission API uses distance-based assignment when coordinates are available', async (t) => {
  const eastCoordinates = [
    { lat: 0, lng: 0, address: 'Seoul East residence' },
    { lat: 0, lng: 10, address: 'Seoul East area' }
  ];
  const coordinatesByQuery = {
    'Seoul Central': { lat: 0, lng: 1, address: 'Seoul Central' },
    'Seoul West': { lat: 0, lng: 2, address: 'Seoul West' },
    'Gyeonggi North': { lat: 0, lng: 3, address: 'Gyeonggi North' },
    'Gyeonggi South': { lat: 0, lng: 4, address: 'Gyeonggi South' },
    Gangnam: { lat: 0, lng: 5, address: 'Gangnam' }
  };
  const geocoder = {
    async geocode(query) {
      return this.tryGeocode(query);
    },
    async tryGeocode(query) {
      if (query === 'Seoul East') {
        return eastCoordinates.shift() || { lat: 0, lng: 10, address: 'Seoul East area' };
      }
      return coordinatesByQuery[query] || null;
    }
  };

  const { baseUrl } = await createTestServer(t, { geocoder });
  const response = await fetch(`${baseUrl}/api/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      researcher: { name: 'Han', residenceArea: 'Seoul East' },
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
  assert.equal(payload.assignment.currentArea, 'Seoul Central');
  assert.equal(payload.assignment.method, 'distance-fairness-blend');
  assert.deepEqual(payload.researcher.coordinates, { lat: 0, lng: 0 });
  assert.deepEqual(payload.survey.coordinates, { lat: 0, lng: 5 });
});
