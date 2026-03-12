const PROXIMITY_TIERS = {
  '서울 중부': {
    0: ['서울 중부'],
    1: ['서울 동부', '서울 서부'],
    2: ['경기 북부', '경기 남부']
  },
  '서울 동부': {
    0: ['서울 동부'],
    1: ['서울 중부', '경기 남부'],
    2: ['서울 서부', '경기 북부']
  },
  '서울 서부': {
    0: ['서울 서부'],
    1: ['서울 중부', '경기 북부'],
    2: ['서울 동부', '경기 남부']
  },
  '경기 북부': {
    0: ['경기 북부'],
    1: ['서울 서부'],
    2: ['서울 중부', '서울 동부'],
    3: ['경기 남부']
  },
  '경기 남부': {
    0: ['경기 남부'],
    1: ['서울 동부'],
    2: ['서울 중부', '서울 서부'],
    3: ['경기 북부']
  }
};

function proximityTier(residenceArea, candidateArea) {
  const tiers = PROXIMITY_TIERS[residenceArea] || { 0: [residenceArea] };
  for (const [tier, areas] of Object.entries(tiers)) {
    if (areas.includes(candidateArea)) return Number(tier);
  }
  return Number.MAX_SAFE_INTEGER;
}

function isCoordinate(coord) {
  return Number.isFinite(coord?.lat) && Number.isFinite(coord?.lng);
}

function normalizeMetric(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => 0);
  return values.map((value) => (value - min) / (max - min));
}

export function haversineDistanceKm(origin, destination) {
  if (!isCoordinate(origin) || !isCoordinate(destination)) {
    throw new Error('Both origin and destination coordinates are required.');
  }

  const earthRadiusKm = 6371;
  const latDelta = ((destination.lat - origin.lat) * Math.PI) / 180;
  const lngDelta = ((destination.lng - origin.lng) * Math.PI) / 180;
  const originLat = (origin.lat * Math.PI) / 180;
  const destinationLat = (destination.lat * Math.PI) / 180;
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(originLat) * Math.cos(destinationLat) * Math.sin(lngDelta / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
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

export function assignAreaByDistance({
  residenceCoord,
  areaCoords,
  submissionCounts = {},
  distanceWeight = 0.7,
  fairnessWeight = 0.3
}) {
  if (!isCoordinate(residenceCoord)) {
    throw new Error('residenceCoord is required.');
  }

  const candidates = Object.entries(areaCoords || {})
    .filter(([, coord]) => isCoordinate(coord))
    .map(([area, coord]) => ({
      area,
      distanceKm: haversineDistanceKm(residenceCoord, coord),
      submissionCount: submissionCounts[area] || 0
    }));

  if (!candidates.length) {
    throw new Error('At least one area coordinate is required.');
  }

  const normalizedDistances = normalizeMetric(candidates.map((candidate) => candidate.distanceKm));
  const normalizedCounts = normalizeMetric(candidates.map((candidate) => candidate.submissionCount));

  const ranked = candidates
    .map((candidate, index) => ({
      ...candidate,
      score:
        distanceWeight * normalizedDistances[index] +
        fairnessWeight * normalizedCounts[index]
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      if (left.distanceKm !== right.distanceKm) return left.distanceKm - right.distanceKm;
      if (left.submissionCount !== right.submissionCount) {
        return left.submissionCount - right.submissionCount;
      }
      return left.area.localeCompare(right.area);
    });

  return {
    assignedArea: ranked[0].area,
    candidateOrder: ranked.map((candidate) => candidate.area)
  };
}
