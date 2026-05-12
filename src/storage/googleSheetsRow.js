import { getSubmissionAvailability } from '../availability.js';

export function flattenSubmissionForSheet(submission, products) {
  const availabilitySet = new Set();

  for (const item of getSubmissionAvailability(submission)) {
    if (item.present !== false) {
      availabilitySet.add(`${item.productLabel} ${item.size}`);
    }
  }

  const row = [
    submission.id,
    submission.createdAt,
    submission.researcher.name,
    submission.researcher.residenceArea,
    submission.assignment.currentArea,
    submission.survey.region,
    submission.survey.storeType,
    submission.survey.storeName,
    submission.survey.posCount,
    submission.survey.displayLocation,
    submission.photo?.url || '',
    submission.notes || ''
  ];

  for (const product of products) {
    for (const size of product.sizes) {
      row.push(availabilitySet.has(`${product.label} ${size}`) ? 'Y' : '');
    }
  }

  return row;
}
