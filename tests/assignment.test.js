import test from 'node:test';
import assert from 'node:assert/strict';
import { assignArea } from '../src/assignment.js';

test('assignArea prefers the researcher residence area before fairness', () => {
  const result = assignArea({
    residenceArea: '서울 동부',
    areas: ['서울 중부', '서울 동부', '서울 서부'],
    submissionCounts: {
      '서울 동부': 8,
      '서울 중부': 0,
      '서울 서부': 0
    }
  });

  assert.equal(result.assignedArea, '서울 동부');
  assert.deepEqual(result.candidateOrder, ['서울 동부', '서울 중부', '서울 서부']);
});

test('assignArea uses fairness as a tie-breaker inside the same proximity tier', () => {
  const result = assignArea({
    residenceArea: '서울 중부',
    areas: ['서울 동부', '서울 서부'],
    submissionCounts: {
      '서울 동부': 5,
      '서울 서부': 1
    }
  });

  assert.equal(result.assignedArea, '서울 서부');
});

test('assignArea falls back to the first configured area for an unknown residence', () => {
  const result = assignArea({
    residenceArea: 'Busan',
    areas: ['서울 중부', '서울 동부', '서울 서부'],
    submissionCounts: {
      '서울 중부': 3,
      '서울 동부': 0,
      '서울 서부': 0
    }
  });

  assert.equal(result.assignedArea, '서울 중부');
  assert.deepEqual(result.candidateOrder, ['서울 중부', '서울 동부', '서울 서부']);
});
