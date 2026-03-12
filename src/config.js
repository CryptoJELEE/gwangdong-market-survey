import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_AREAS,
  DEFAULT_PRODUCTS,
  DEFAULT_STORE_TYPE_TEMPLATES,
  GOOGLE_SHEETS_SUBMISSION_HEADERS,
  buildPriceColumnHeaders
} from './catalog.js';

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return {};
  const raw = readFileSync(envPath, 'utf8');
  return raw.split(/\r?\n/).reduce((accumulator, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return accumulator;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return accumulator;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    accumulator[key] = value;
    return accumulator;
  }, {});
}

export function loadConfig(env = process.env) {
  const mergedEnv = { ...loadDotEnv(), ...env };
  const rootDir = process.cwd();
  const dataDir = path.resolve(rootDir, mergedEnv.DATA_DIR || 'data');
  const uploadsDir = path.resolve(rootDir, mergedEnv.UPLOADS_DIR || path.join(dataDir, 'uploads'));
  const storeFile = path.resolve(rootDir, mergedEnv.STORE_FILE || path.join(dataDir, 'store.json'));
  const dbFile = path.resolve(rootDir, mergedEnv.DB_FILE || path.join(dataDir, 'survey.db'));
  const products = DEFAULT_PRODUCTS;

  return {
    port: Number(mergedEnv.PORT || 3000),
    adminToken: mergedEnv.ADMIN_TOKEN || '',
    adminPassword: mergedEnv.ADMIN_PASSWORD || 'ionroad2026',
    kakaoRestApiKey: mergedEnv.KAKAO_REST_API_KEY || '',
    areas: DEFAULT_AREAS,
    products,
    storeTypeTemplates: DEFAULT_STORE_TYPE_TEMPLATES,
    dataDir,
    uploadsDir,
    storeFile,
    dbFile,
    googleSheets: {
      enabled: String(mergedEnv.GOOGLE_SHEETS_ENABLED || 'false').toLowerCase() === 'true',
      spreadsheetId: mergedEnv.GOOGLE_SHEETS_SPREADSHEET_ID || '',
      clientEmail: mergedEnv.GOOGLE_SHEETS_CLIENT_EMAIL || '',
      privateKey: (mergedEnv.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      submissionsRange: mergedEnv.GOOGLE_SHEETS_SUBMISSIONS_RANGE || 'Submissions!A:Z',
      assignmentsRange: mergedEnv.GOOGLE_SHEETS_ASSIGNMENTS_RANGE || 'Assignments!A:Z',
      submissionHeaders: [
        ...GOOGLE_SHEETS_SUBMISSION_HEADERS,
        ...buildPriceColumnHeaders(products)
      ]
    }
  };
}
