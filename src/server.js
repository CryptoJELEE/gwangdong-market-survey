import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { assignArea } from './assignment.js';
import { SurveyStore } from './storage/index.js';
import { collectJsonBody, json } from './utils.js';

function validateSubmission(body, config) {
  const required = [
    body.researcher?.name,
    body.researcher?.residenceArea,
    body.survey?.region,
    body.survey?.storeType,
    body.survey?.storeName
  ];
  if (required.some((item) => !item)) {
    throw new Error('Missing required submission fields.');
  }

  const prices = (body.prices || []).filter((item) => item.price !== '' && item.price !== null && item.price !== undefined);
  if (!prices.length) {
    throw new Error('At least one product price is required.');
  }

  return {
    researcher: {
      name: body.researcher.name,
      residenceArea: config.areas.includes(body.researcher.residenceArea) ? body.researcher.residenceArea : config.areas[0]
    },
    survey: {
      region: body.survey.region,
      storeType: body.survey.storeType,
      storeName: body.survey.storeName,
      posCount: Number(body.survey.posCount || 0),
      displayLocation: body.survey.displayLocation || ''
    },
    prices: prices.map((item) => ({
      productId: item.productId,
      productLabel: item.productLabel,
      size: item.size,
      price: Number(item.price)
    })),
    photoDataUrl: body.photoDataUrl || '',
    notes: body.notes || ''
  };
}

async function serveStatic(response, filePath) {
  const contents = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  };
  response.writeHead(200, { 'Content-Type': contentTypes[extension] || 'application/octet-stream' });
  response.end(contents);
}

export function createApp(config = loadConfig()) {
  const store = new SurveyStore(config);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (request.method === 'GET' && url.pathname === '/') {
        await serveStatic(response, path.resolve('src/client/index.html'));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        await serveStatic(response, path.resolve('src/client/app.js'));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/styles.css') {
        await serveStatic(response, path.resolve('src/client/styles.css'));
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        await serveStatic(response, path.resolve(config.uploadsDir, url.pathname.replace('/uploads/', '')));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const submissions = await store.listSubmissions();
        const assignmentOverrides = await store.listAssignmentOverrides();
        json(response, 200, {
          areas: config.areas,
          products: config.products,
          storeTypeTemplates: config.storeTypeTemplates,
          submissions,
          assignmentOverrides,
          adminTokenConfigured: Boolean(config.adminToken)
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/submissions') {
        const body = await collectJsonBody(request);
        const payload = validateSubmission(body, config);
        const submissionCounts = await store.getSubmissionCounts();
        const assignment = assignArea({
          residenceArea: payload.researcher.residenceArea,
          areas: config.areas,
          submissionCounts
        });
        const submission = await store.createSubmission({
          ...payload,
          assignment: {
            currentArea: assignment.assignedArea,
            candidateOrder: assignment.candidateOrder,
            method: 'residence-proximity-then-fairness'
          }
        });
        json(response, 201, submission);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/assignments/override') {
        const body = await collectJsonBody(request);
        if (!body.submissionId || !body.assignedArea) {
          throw new Error('submissionId and assignedArea are required.');
        }
        const updated = await store.overrideAssignment({
          submissionId: body.submissionId,
          assignedArea: body.assignedArea,
          reason: body.reason || '',
          adminName: body.adminName || 'Admin'
        });
        json(response, 200, updated);
        return;
      }

      json(response, 404, { error: 'Not found' });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  const server = createApp(config);
  server.listen(config.port, () => {
    console.log(`Market survey MVP running at http://localhost:${config.port}`);
  });
}
