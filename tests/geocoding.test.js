import test from 'node:test';
import assert from 'node:assert/strict';
import { assignAreaByDistance, haversineDistanceKm } from '../src/assignment.js';
import { createGeocoder } from '../src/geocoding.js';

test('haversineDistanceKm returns zero for identical coordinates', () => {
  const distance = haversineDistanceKm(
    { lat: 37.5665, lng: 126.978 },
    { lat: 37.5665, lng: 126.978 }
  );

  assert.equal(distance, 0);
});

test('haversineDistanceKm approximates one degree of longitude at the equator', () => {
  const distance = haversineDistanceKm(
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 }
  );

  assert.ok(distance > 111);
  assert.ok(distance < 112);
});

test('assignAreaByDistance prefers the closest area when submission counts are equal', () => {
  const result = assignAreaByDistance({
    residenceCoord: { lat: 37.5665, lng: 126.978 },
    areaCoords: {
      'Seoul Central': { lat: 37.5665, lng: 126.978 },
      'Seoul East': { lat: 37.551, lng: 127.146 }
    },
    submissionCounts: {
      'Seoul Central': 2,
      'Seoul East': 2
    }
  });

  assert.equal(result.assignedArea, 'Seoul Central');
  assert.deepEqual(result.candidateOrder, ['Seoul Central', 'Seoul East']);
});

test('assignAreaByDistance uses fairness as a tie-breaker when distances are equal', () => {
  const result = assignAreaByDistance({
    residenceCoord: { lat: 37.5665, lng: 126.978 },
    areaCoords: {
      'Seoul Central': { lat: 37.5665, lng: 127.078 },
      'Seoul West': { lat: 37.5665, lng: 126.878 }
    },
    submissionCounts: {
      'Seoul Central': 5,
      'Seoul West': 1
    }
  });

  assert.equal(result.assignedArea, 'Seoul West');
  assert.deepEqual(result.candidateOrder, ['Seoul West', 'Seoul Central']);
});

test('createGeocoder caches Kakao responses by query', async () => {
  let calls = 0;
  const cache = new Map();
  const geocoder = createGeocoder({
    apiKey: 'test-key',
    store: {
      async getCachedGeocode(query) {
        return cache.get(query) || null;
      },
      async setCachedGeocode(query, lat, lng, address) {
        const value = { lat, lng, address };
        cache.set(query, value);
        return value;
      }
    },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        async json() {
          return {
            documents: [
              {
                x: '126.9780',
                y: '37.5665',
                address_name: '서울특별시 중구'
              }
            ]
          };
        }
      };
    }
  });

  const first = await geocoder.geocode('Seoul Central');
  const second = await geocoder.geocode('Seoul Central');

  assert.equal(calls, 1);
  assert.deepEqual(first, {
    lat: 37.5665,
    lng: 126.978,
    address: '서울특별시 중구'
  });
  assert.deepEqual(second, first);
});
