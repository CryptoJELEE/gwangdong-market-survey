const PROXIMITY_TIERS = {
  'Seoul Central': {
    0: ['Seoul Central'],
    1: ['Seoul East', 'Seoul West'],
    2: ['Gyeonggi North', 'Gyeonggi South']
  },
  'Seoul East': {
    0: ['Seoul East'],
    1: ['Seoul Central', 'Gyeonggi South'],
    2: ['Seoul West', 'Gyeonggi North']
  },
  'Seoul West': {
    0: ['Seoul West'],
    1: ['Seoul Central', 'Gyeonggi North'],
    2: ['Seoul East', 'Gyeonggi South']
  },
  'Gyeonggi North': {
    0: ['Gyeonggi North'],
    1: ['Seoul West'],
    2: ['Seoul Central', 'Seoul East'],
    3: ['Gyeonggi South']
  },
  'Gyeonggi South': {
    0: ['Gyeonggi South'],
    1: ['Seoul East'],
    2: ['Seoul Central', 'Seoul West'],
    3: ['Gyeonggi North']
  }
};

function proximityTier(residenceArea, candidateArea) {
  const tiers = PROXIMITY_TIERS[residenceArea] || { 0: [residenceArea] };
  for (const [tier, areas] of Object.entries(tiers)) {
    if (areas.includes(candidateArea)) return Number(tier);
  }
  return Number.MAX_SAFE_INTEGER;
}

export function assignArea({ residenceArea, areas, submissionCounts = {} }) {
  if (!PROXIMITY_TIERS[residenceArea]) {
    residenceArea = areas[0];
  }

  const ranked = [...areas].sort((left, right) => {
    const leftTier = proximityTier(residenceArea, left);
    const rightTier = proximityTier(residenceArea, right);
    if (leftTier !== rightTier) return leftTier - rightTier;

    const leftCount = submissionCounts[left] || 0;
    const rightCount = submissionCounts[right] || 0;
    if (leftCount !== rightCount) return leftCount - rightCount;

    return left.localeCompare(right);
  });

  return {
    assignedArea: ranked[0],
    candidateOrder: ranked
  };
}
