import { SQLiteStore } from './sqliteStore.js';
import { GoogleSheetsMirror } from './googleSheetsStore.js';

export class SurveyStore {
  constructor(config) {
    this.localStore = new SQLiteStore(config);
    this.googleSheetsMirror = new GoogleSheetsMirror({
      ...config.googleSheets,
      products: config.products
    });
  }

  async init() {
    await this.localStore.init();
  }

  close() {
    if (this.localStore.close) this.localStore.close();
  }

  async getSubmissionCounts() {
    return this.localStore.getSubmissionCounts();
  }

  async getCachedGeocode(query) {
    return this.localStore.getCachedGeocode(query);
  }

  async setCachedGeocode(query, lat, lng, address) {
    return this.localStore.setCachedGeocode(query, lat, lng, address);
  }

  async listSubmissions() {
    return this.localStore.listSubmissions();
  }

  async listAssignmentOverrides() {
    return this.localStore.listAssignmentOverrides();
  }

  async createSubmission(payload) {
    const submission = await this.localStore.createSubmission(payload);
    try {
      await this.googleSheetsMirror.appendSubmission(submission);
      if (this.googleSheetsMirror.isEnabled()) {
        submission.sync.mode = 'local+google-sheets';
      }
    } catch (error) {
      submission.sync.error = error.message;
    }
    return submission;
  }

  async overrideAssignment(payload) {
    const submission = await this.localStore.overrideAssignment(payload);
    try {
      await this.googleSheetsMirror.appendAssignmentOverride(submission);
    } catch (error) {
      submission.sync.error = error.message;
    }
    return submission;
  }

  async importSubmissions(submissions) {
    return this.localStore.importSubmissions(submissions);
  }

  async deleteSubmission(submissionId) {
    return this.localStore.deleteSubmission(submissionId);
  }

  async getAdminPassword() {
    return this.localStore.getAdminPassword();
  }

  async setAdminPassword(password) {
    return this.localStore.setAdminPassword(password);
  }

  async getSetting(key) {
    return this.localStore.getSetting(key);
  }

  async setSetting(key, value) {
    return this.localStore.setSetting(key, value);
  }
}
