import { parseEngineReportBody } from "./engine-report-contract.mjs";

const RUNNER_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const ENGINE_REPORT_PATTERN = /^egr_[0-9a-f]{32}$/u;

const registry = Object.freeze({
  "engine.report": Object.freeze({
    bodyIdentity(body) {
      const report = parseEngineReportBody(body);
      return report ? { reportId: report.reportId } : undefined;
    },
    identity(entry) {
      return RUNNER_PATTERN.test(entry.runnerId ?? "") &&
        ENGINE_REPORT_PATTERN.test(entry.reportId ?? "")
        ? { reportId: entry.reportId, runnerId: entry.runnerId }
        : undefined;
    },
    pathname(entry) {
      return `/api/runners/${entry.runnerId}/engine-reports`;
    },
  }),
});

export function declarationContract(kind) {
  return typeof kind === "string" && Object.hasOwn(registry, kind)
    ? registry[kind]
    : undefined;
}
