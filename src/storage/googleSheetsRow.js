export function flattenSubmissionForSheet(submission, products) {
  const priceMap = new Map();

  for (const price of submission.prices || []) {
    priceMap.set(`${price.productLabel} ${price.size}`, price.price);
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
      row.push(priceMap.get(`${product.label} ${size}`) ?? '');
    }
  }

  return row;
}

