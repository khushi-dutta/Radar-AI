// Pearson correlation between two arrays
export function pearsonCorrelation(x, y) {
  if (!x || !y || x.length !== y.length || x.length === 0) return 0;
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const numerator = (n * sumXY) - (sumX * sumY);
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function findDivergingCorrelations(items) {
  const pairs = [];
  const validItems = items.filter(i => i.sparkline && i.sparkline.length > 5 && i.dayChangePct !== null);
  for (let i = 0; i < validItems.length; i++) {
    for (let j = i + 1; j < validItems.length; j++) {
      const a = validItems[i];
      const b = validItems[j];
      const corr = pearsonCorrelation(a.sparkline, b.sparkline);
      // High correlation usually (> 0.7)
      if (corr > 0.7) {
        // Are they diverging today? Difference in day change > 2%
        if (Math.abs(a.dayChangePct - b.dayChangePct) >= 2.0) {
          pairs.push({
            stock1: a.symbol,
            stock2: b.symbol,
            correlation: Number(corr.toFixed(2)),
            divergence: Number(Math.abs(a.dayChangePct - b.dayChangePct).toFixed(2)),
            stock1Change: a.dayChangePct,
            stock2Change: b.dayChangePct
          });
        }
      }
    }
  }
  return pairs;
}
