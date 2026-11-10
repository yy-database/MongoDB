// 基准计时与统计。median/p95 走上游 `database.harness` 的基准统计（与产品共用 `.node`），
// 不在本地重写统计算法；空样本等非法输入由上游拒绝，不返回貌似成功的 0/NaN。
import { binding } from "../../../packages/mongo/dist/binding.js";

export function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

/** 对一组毫秒样本求 median/p95/极值（nearest-rank，公式由上游 golden vector 钉死）。 */
export function benchSummary(samples) {
  if (typeof binding.harnessBenchSummary !== "function") {
    throw new Error("addon has no `harnessBenchSummary`; rebuild it with `npm run build:napi`");
  }
  return binding.harnessBenchSummary([...samples]);
}

export function median(samples) {
  return benchSummary(samples).medianMs;
}

export function p95(samples) {
  return benchSummary(samples).p95Ms;
}

export function throughput(rows, ms) {
  if (ms <= 0) return "n/a";
  return `${Math.round((rows / ms) * 1_000).toLocaleString("en-US")}/s`;
}
