const AREA_QUERY_ALIASES = {
  'Seoul Central': '서울특별시 중구',
  'Seoul East': '서울특별시 강동구',
  'Seoul West': '서울특별시 마포구',
  'Gyeonggi North': '경기도 의정부시',
  'Gyeonggi South': '경기도 수원시'
};

function normalizeQuery(query) {
  return String(query || '').trim();
}

function toCoordinate(value) {
  return Number.parseFloat(value);
}

function resolveQuery(query) {
  return AREA_QUERY_ALIASES[query] || query;
}

function normalizeResult(result) {
  return {
    lat: result.lat,
    lng: result.lng,
    address: result.address
  };
}

export function createGeocoder({ apiKey, store, fetchImpl = fetch } = {}) {
  return {
    async geocode(query) {
      const normalizedQuery = normalizeQuery(query);
      if (!normalizedQuery) {
        throw new Error('query is required.');
      }

      if (store?.getCachedGeocode) {
        const cached = await store.getCachedGeocode(normalizedQuery);
        if (cached) return normalizeResult(cached);
      }

      if (!apiKey) {
        throw new Error('KAKAO_REST_API_KEY is not configured.');
      }

      const endpoint = new URL('https://dapi.kakao.com/v2/local/search/address.json');
      endpoint.searchParams.set('query', resolveQuery(normalizedQuery));

      const response = await fetchImpl(endpoint, {
        headers: {
          Authorization: `KakaoAK ${apiKey}`
        }
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Kakao geocoding failed: ${response.status} ${body}`);
      }

      const payload = await response.json();
      const document = payload.documents?.[0];
      if (!document) {
        throw new Error(`No geocoding result found for "${normalizedQuery}".`);
      }

      const result = {
        lat: toCoordinate(document.y),
        lng: toCoordinate(document.x),
        address:
          document.road_address?.address_name ||
          document.address?.address_name ||
          document.address_name ||
          normalizedQuery
      };

      if (store?.setCachedGeocode) {
        await store.setCachedGeocode(normalizedQuery, result.lat, result.lng, result.address);
      }

      return result;
    },

    async tryGeocode(query) {
      try {
        return await this.geocode(query);
      } catch {
        return null;
      }
    }
  };
}
