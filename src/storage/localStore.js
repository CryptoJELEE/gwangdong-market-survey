import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createId, decodeDataUrl, ensureDir, nowIso, readJson, slugify, writeJson } from '../utils.js';

function emptyState(config) {
  return {
    configVersion: 1,
    areas: config.areas,
    submissions: [],
    assignmentOverrides: []
  };
}

export class LocalStore {
  constructor(config) {
    this.config = config;
  }

  async init() {
    await ensureDir(path.dirname(this.config.storeFile));
    await ensureDir(this.config.uploadsDir);
    const state = await readJson(this.config.storeFile, null);
    if (!state) {
      await writeJson(this.config.storeFile, emptyState(this.config));
    }
  }

  async readState() {
    await this.init();
    return readJson(this.config.storeFile, emptyState(this.config));
  }

  async writeState(state) {
    await writeJson(this.config.storeFile, state);
  }

  async listSubmissions() {
    const state = await this.readState();
    return state.submissions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listAssignmentOverrides() {
    const state = await this.readState();
    return state.assignmentOverrides.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSubmissionCounts() {
    const submissions = await this.listSubmissions();
    return submissions.reduce((accumulator, submission) => {
      const key = submission.assignment.currentArea;
      accumulator[key] = (accumulator[key] || 0) + 1;
      return accumulator;
    }, {});
  }

  async savePhoto(photoDataUrl, storeName) {
    if (!photoDataUrl) return null;
    const { mimeType, buffer } = decodeDataUrl(photoDataUrl);
    const extension = mimeType.split('/')[1] || 'bin';
    const filename = `${slugify(storeName)}-${Date.now()}.${extension}`;
    const filePath = path.join(this.config.uploadsDir, filename);
    await writeFile(filePath, buffer);
    return {
      filename,
      mimeType,
      url: `/uploads/${filename}`
    };
  }

  async createSubmission(payload) {
    const state = await this.readState();
    const photo = await this.savePhoto(payload.photoDataUrl, payload.survey.storeName);
    const submission = {
      id: createId('submission'),
      createdAt: nowIso(),
      researcher: payload.researcher,
      survey: payload.survey,
      prices: payload.prices,
      notes: payload.notes || '',
      photo,
      assignment: payload.assignment,
      sync: {
        mode: 'local'
      }
    };
    state.submissions.push(submission);
    await this.writeState(state);
    return submission;
  }

  async overrideAssignment({ submissionId, assignedArea, reason, adminName }) {
    const state = await this.readState();
    const submission = state.submissions.find((item) => item.id === submissionId);
    if (!submission) {
      throw new Error('Submission not found.');
    }

    submission.assignment.currentArea = assignedArea;
    submission.assignment.overrideReason = reason;
    submission.assignment.overriddenBy = adminName;
    submission.assignment.overriddenAt = nowIso();

    state.assignmentOverrides.push({
      id: createId('override'),
      submissionId,
      assignedArea,
      reason,
      adminName,
      updatedAt: submission.assignment.overriddenAt
    });

    await this.writeState(state);
    return submission;
  }
}
