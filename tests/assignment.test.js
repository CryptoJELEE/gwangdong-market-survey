import test from 'node:test';
import assert from 'node:assert/strict';
import { assignArea } from '../src/assignment.js';

test('assignArea prefers the researcher residence area before fairness', () => {
  const result = assignArea({
    residenceArea: 'Seoul East',
    areas: ['Seoul Central', 'Seoul East', 'Seoul West'],
    submissionCounts: {
      'Seoul East': 8,
      'Seoul Central': 0,
      'Seoul West': 0
    }
  });

  assert.equal(result.assignedArea, 'Seoul East');
  assert.deepEqual(result.candidateOrder, ['Seoul East', 'Seoul Central', 'Seoul West']);
});

test('assignArea uses fairness as a tie-breaker inside the same proximity tier', () => {
  const result = assignArea({
    residenceArea: 'Seoul Central',
    areas: ['Seoul East', 'Seoul West'],
    submissionCounts: {
      'Seoul East': 5,
      'Seoul West': 1
    }
  });

  assert.equal(result.assignedArea, 'Seoul West');
});

test('assignArea falls back to the first configured area for an unknown residence', () => {
  const result = assignArea({
    residenceArea: 'Busan',
    areas: ['Seoul Central', 'Seoul East', 'Seoul West'],
    submissionCounts: {
      'Seoul Central': 3,
      'Seoul East': 0,
      'Seoul West': 0
    }
  });

  assert.equal(result.assignedArea, 'Seoul Central');
  assert.deepEqual(result.candidateOrder, ['Seoul Central', 'Seoul East', 'Seoul West']);
});
