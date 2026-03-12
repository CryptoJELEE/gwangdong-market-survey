export const DEFAULT_AREAS = [
  'Seoul Central',
  'Seoul East',
  'Seoul West',
  'Gyeonggi North',
  'Gyeonggi South'
];

export const DEFAULT_STORE_TYPE_TEMPLATES = [
  { id: 'emart-gs-super', label: '이마트 / GS 슈퍼', defaultPosCount: 2 },
  { id: 'convenience', label: '편의점', defaultPosCount: 1 },
  { id: 'supermarket-large', label: '슈퍼 (POS 2개 이상)', defaultPosCount: 2 }
];

export const DEFAULT_PRODUCTS = [
  {
    id: 'ion-kick',
    label: '이온킥',
    brand: '광동제약',
    sizes: ['캔 240ml', 'PET 500ml', 'PET 1.5L']
  },
  {
    id: 'pocari-sweat',
    label: '포카리스웨트',
    brand: '경쟁사',
    sizes: ['캔 240ml', '캔 355ml', 'PET 620ml', 'PET 1.5L']
  },
  {
    id: 'powerade',
    label: '파워에이드',
    brand: '경쟁사',
    sizes: ['캔 240ml', '캔 355ml', 'PET 600ml', 'PET 1.5L']
  },
  {
    id: 'gatorade',
    label: '게토레이',
    brand: '경쟁사',
    sizes: ['캔 240ml', 'PET 600ml', 'PET 1.5L']
  },
  {
    id: 'sunkist',
    label: '썬키스트',
    brand: '경쟁사',
    sizes: ['사과 1.35L', '매실 1.35L']
  }
];

export const GOOGLE_SHEETS_SUBMISSION_HEADERS = [
  '제출ID',
  '제출일시',
  '조사자',
  '거주지역',
  '자동배정지역',
  '조사지역',
  '거래처',
  '점포명',
  'POS 대수',
  '진열위치',
  '사진URL',
  '메모'
];

export function buildPriceColumnHeaders(products) {
  const headers = [];
  for (const product of products) {
    for (const size of product.sizes) {
      headers.push(`${product.label} ${size}`);
    }
  }
  return headers;
}

