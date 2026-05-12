export function availabilityFromPrices(prices = []) {
  return (Array.isArray(prices) ? prices : [])
    .map((item) => ({
      productId: item.productId,
      productLabel: item.productLabel,
      size: item.size,
      present: Number(String(item.price).replace(/[^0-9]/g, '')) > 0
    }))
    .filter((item) => item.productId && item.size && item.present);
}

export function getSubmissionAvailability(submission) {
  if (Array.isArray(submission?.availability)) return submission.availability;
  return availabilityFromPrices(submission?.prices || []);
}

export function availabilityKey(productId, size) {
  return `${productId}__${size}`;
}
