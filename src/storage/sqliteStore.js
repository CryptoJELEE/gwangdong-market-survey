import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createId, decodeDataUrl, ensureDir, nowIso, slugify } from '../utils.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  researcher_name TEXT NOT NULL,
  researcher_residence_area TEXT NOT NULL,
  researcher_residence_lat REAL,
  researcher_residence_lng REAL,
  survey_region TEXT NOT NULL,
  survey_store_type TEXT NOT NULL,
  survey_store_name TEXT NOT NULL,
  survey_pos_count INTEGER DEFAULT 0,
  survey_display_location TEXT DEFAULT '',
  survey_location_lat REAL,
  survey_location_lng REAL,
  prices_json TEXT NOT NULL,
  notes TEXT DEFAULT '',
  photo_filename TEXT,
  photo_mime_type TEXT,
  photo_url TEXT,
  assignment_current_area TEXT NOT NULL,
  assignment_candidate_order TEXT,
  assignment_method TEXT,
  assignment_override_reason TEXT,
  assignment_overridden_by TEXT,
  assignment_overridden_at TEXT,
  sync_mode TEXT DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS assignment_overrides (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  assigned_area TEXT NOT NULL,
  reason TEXT DEFAULT '',
  admin_name TEXT DEFAULT 'Admin',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS geocode_cache (
  query TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
`;

const SUBMISSION_COLUMN_MIGRATIONS = [
  ['researcher_residence_lat', 'ALTER TABLE submissions ADD COLUMN researcher_residence_lat REAL'],
  ['researcher_residence_lng', 'ALTER TABLE submissions ADD COLUMN researcher_residence_lng REAL'],
  ['survey_location_lat', 'ALTER TABLE submissions ADD COLUMN survey_location_lat REAL'],
  ['survey_location_lng', 'ALTER TABLE submissions ADD COLUMN survey_location_lng REAL']
];

function buildCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

function rowToSubmission(row) {
  const researcherCoordinates = buildCoordinates(row.researcher_residence_lat, row.researcher_residence_lng);
  const surveyCoordinates = buildCoordinates(row.survey_location_lat, row.survey_location_lng);

  return {
    id: row.id,
    createdAt: row.created_at,
    researcher: {
      name: row.researcher_name,
      residenceArea: row.researcher_residence_area,
      ...(researcherCoordinates ? { coordinates: researcherCoordinates } : {})
    },
    survey: {
      region: row.survey_region,
      storeType: row.survey_store_type,
      storeName: row.survey_store_name,
      posCount: row.survey_pos_count,
      displayLocation: row.survey_display_location,
      ...(surveyCoordinates ? { coordinates: surveyCoordinates } : {})
    },
    prices: JSON.parse(row.prices_json),
    notes: row.notes || '',
    photo: row.photo_filename
      ? { filename: row.photo_filename, mimeType: row.photo_mime_type, url: row.photo_url }
      : null,
    assignment: {
      currentArea: row.assignment_current_area,
      candidateOrder: row.assignment_candidate_order ? JSON.parse(row.assignment_candidate_order) : undefined,
      method: row.assignment_method,
      ...(row.assignment_override_reason != null ? { overrideReason: row.assignment_override_reason } : {}),
      ...(row.assignment_overridden_by != null ? { overriddenBy: row.assignment_overridden_by } : {}),
      ...(row.assignment_overridden_at != null ? { overriddenAt: row.assignment_overridden_at } : {})
    },
    sync: { mode: row.sync_mode || 'local' }
  };
}

function rowToOverride(row) {
  return {
    id: row.id,
    submissionId: row.submission_id,
    assignedArea: row.assigned_area,
    reason: row.reason,
    adminName: row.admin_name,
    updatedAt: row.updated_at
  };
}

export class SQLiteStore {
  constructor(config) {
    this.config = config;
    this.db = null;
  }

  async init() {
    await ensureDir(path.dirname(this.config.dbFile));
    await ensureDir(this.config.uploadsDir);
    this.db = new Database(this.config.dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this._migrateSubmissionsTable();
  }

  _ensureDb() {
    if (!this.db) throw new Error('SQLiteStore not initialized. Call init() first.');
  }

  _migrateSubmissionsTable() {
    const existingColumns = new Set(
      this.db.prepare('PRAGMA table_info(submissions)').all().map((row) => row.name)
    );

    for (const [columnName, statement] of SUBMISSION_COLUMN_MIGRATIONS) {
      if (!existingColumns.has(columnName)) {
        this.db.exec(statement);
      }
    }
  }

  async listSubmissions() {
    this._ensureDb();
    const rows = this.db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
    return rows.map(rowToSubmission);
  }

  async listAssignmentOverrides() {
    this._ensureDb();
    const rows = this.db.prepare('SELECT * FROM assignment_overrides ORDER BY updated_at DESC').all();
    return rows.map(rowToOverride);
  }

  async getSubmissionCounts() {
    this._ensureDb();
    const rows = this.db.prepare(
      'SELECT assignment_current_area AS area, COUNT(*) AS cnt FROM submissions GROUP BY assignment_current_area'
    ).all();
    return rows.reduce((acc, row) => {
      acc[row.area] = row.cnt;
      return acc;
    }, {});
  }

  async getCachedGeocode(query) {
    this._ensureDb();
    const row = this.db.prepare(
      'SELECT query, lat, lng, address, cached_at FROM geocode_cache WHERE query = ?'
    ).get(String(query || '').trim());
    if (!row) return null;
    return {
      lat: row.lat,
      lng: row.lng,
      address: row.address,
      cachedAt: row.cached_at
    };
  }

  async setCachedGeocode(query, lat, lng, address) {
    this._ensureDb();
    const normalizedQuery = String(query || '').trim();
    const cachedAt = nowIso();
    this.db.prepare(`
      INSERT INTO geocode_cache (query, lat, lng, address, cached_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(query) DO UPDATE SET
        lat = excluded.lat,
        lng = excluded.lng,
        address = excluded.address,
        cached_at = excluded.cached_at
    `).run(normalizedQuery, lat, lng, address, cachedAt);

    return {
      lat,
      lng,
      address,
      cachedAt
    };
  }

  async savePhoto(photoDataUrl, storeName) {
    if (!photoDataUrl) return null;
    const { mimeType, buffer } = decodeDataUrl(photoDataUrl);
    const extension = mimeType.split('/')[1] || 'bin';
    const filename = `${slugify(storeName)}-${Date.now()}.${extension}`;
    const filePath = path.join(this.config.uploadsDir, filename);
    await writeFile(filePath, buffer);
    return { filename, mimeType, url: `/uploads/${filename}` };
  }

  async createSubmission(payload) {
    this._ensureDb();
    const photo = await this.savePhoto(payload.photoDataUrl, payload.survey.storeName);
    const id = createId('submission');
    const createdAt = nowIso();

    this.db.prepare(`
      INSERT INTO submissions (
        id, created_at,
        researcher_name, researcher_residence_area, researcher_residence_lat, researcher_residence_lng,
        survey_region, survey_store_type, survey_store_name, survey_pos_count, survey_display_location, survey_location_lat, survey_location_lng,
        prices_json, notes,
        photo_filename, photo_mime_type, photo_url,
        assignment_current_area, assignment_candidate_order, assignment_method,
        sync_mode
      ) VALUES (
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?
      )
    `).run(
      id,
      createdAt,
      payload.researcher.name,
      payload.researcher.residenceArea,
      payload.researcher.coordinates?.lat ?? null,
      payload.researcher.coordinates?.lng ?? null,
      payload.survey.region,
      payload.survey.storeType,
      payload.survey.storeName,
      payload.survey.posCount,
      payload.survey.displayLocation,
      payload.survey.coordinates?.lat ?? null,
      payload.survey.coordinates?.lng ?? null,
      JSON.stringify(payload.prices),
      payload.notes || '',
      photo?.filename || null,
      photo?.mimeType || null,
      photo?.url || null,
      payload.assignment.currentArea,
      payload.assignment.candidateOrder ? JSON.stringify(payload.assignment.candidateOrder) : null,
      payload.assignment.method,
      'local'
    );

    return {
      id,
      createdAt,
      researcher: payload.researcher,
      survey: payload.survey,
      prices: payload.prices,
      notes: payload.notes || '',
      photo,
      assignment: payload.assignment,
      sync: { mode: 'local' }
    };
  }

  async overrideAssignment({ submissionId, assignedArea, reason, adminName }) {
    this._ensureDb();
    const row = this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (!row) throw new Error('Submission not found.');

    const overriddenAt = nowIso();

    this.db.prepare(`
      UPDATE submissions SET
        assignment_current_area = ?,
        assignment_override_reason = ?,
        assignment_overridden_by = ?,
        assignment_overridden_at = ?
      WHERE id = ?
    `).run(assignedArea, reason, adminName, overriddenAt, submissionId);

    const overrideId = createId('override');
    this.db.prepare(`
      INSERT INTO assignment_overrides (id, submission_id, assigned_area, reason, admin_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(overrideId, submissionId, assignedArea, reason, adminName, overriddenAt);

    const updated = this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    return rowToSubmission(updated);
  }

  async deleteSubmission(submissionId) {
    this._ensureDb();
    this.db.prepare('DELETE FROM assignment_overrides WHERE submission_id = ?').run(submissionId);
    this.db.prepare('DELETE FROM submissions WHERE id = ?').run(submissionId);
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
