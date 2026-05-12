import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRODUCTS } from '../src/catalog.js';
import { flattenSubmissionForSheet } from '../src/storage/googleSheetsRow.js';

test('flattenSubmissionForSheet expands product availability into wide sheet columns', () => {
  const row = flattenSubmissionForSheet(
    {
      id: 'submission_1',
      createdAt: '2026-03-12T00:00:00.000Z',
      researcher: { name: 'Kim', residenceArea: '서울 중부' },
      assignment: { currentArea: '서울 중부' },
      survey: {
        region: 'Gangnam',
        storeType: '편의점',
        storeName: 'Store A',
        posCount: 1,
        displayLocation: '냉장고'
      },
      photo: { url: '/uploads/store-a.png' },
      notes: 'memo',
      availability: [
        { productLabel: '이온킥', size: '캔 240ml', present: true },
        { productLabel: '포카리스웨트', size: 'PET 620ml', present: true },
        { productLabel: '썬키스트', size: '매실 1.35L', present: true }
      ]
    },
    DEFAULT_PRODUCTS,
  );

  assert.equal(row[0], 'submission_1');
  assert.equal(row[7], 'Store A');
  assert.equal(row[12], 'Y');
  assert.equal(row[17], 'Y');
  assert.equal(row.at(-1), 'Y');
});
