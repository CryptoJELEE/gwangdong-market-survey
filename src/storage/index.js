import { LocalStore } from './localStore.js';
import { GoogleSheetsMirror } from './googleSheetsStore.js';

export class SurveyStore {
  constructor(config) {
    this.localStore = new LocalStore(config);
    this.googleSheetsMirror = new GoogleSheetsMirror({
      ...config.googleSheets,
      products: config.products
    });
  }

  async getSubmissionCounts() {
    return this.localStore.getSubmissionCounts();
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
}
