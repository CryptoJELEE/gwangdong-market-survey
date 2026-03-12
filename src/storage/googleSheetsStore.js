import crypto from 'node:crypto';
import { flattenSubmissionForSheet } from './googleSheetsRow.js';

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

async function createAccessToken(config) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: config.clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claimSet))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(config.privateKey, 'base64url');
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create Google access token: ${response.status} ${body}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

async function appendValues({ accessToken, spreadsheetId, range, values }) {
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to append Google Sheets values: ${response.status} ${body}`);
  }
}

export class GoogleSheetsMirror {
  constructor(config) {
    this.config = config;
  }

  isEnabled() {
    return Boolean(
      this.config.enabled &&
      this.config.spreadsheetId &&
      this.config.clientEmail &&
      this.config.privateKey
    );
  }

  async appendSubmission(submission) {
    if (!this.isEnabled()) return;
    const accessToken = await createAccessToken(this.config);
    await appendValues({
      accessToken,
      spreadsheetId: this.config.spreadsheetId,
      range: this.config.submissionsRange,
      values: [flattenSubmissionForSheet(submission, this.config.products || [])]
    });
  }

  async appendAssignmentOverride(submission) {
    if (!this.isEnabled()) return;
    const accessToken = await createAccessToken(this.config);
    await appendValues({
      accessToken,
      spreadsheetId: this.config.spreadsheetId,
      range: this.config.assignmentsRange,
      values: [[
        submission.id,
        submission.assignment.currentArea,
        submission.assignment.overrideReason || '',
        submission.assignment.overriddenBy || '',
        submission.assignment.overriddenAt || ''
      ]]
    });
  }
}
