export function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

export function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, index)];
}

export function throughput(rows, ms) {
  if (ms <= 0) return "n/a";
  return `${Math.round((rows / ms) * 1_000).toLocaleString("en-US")}/s`;
}
