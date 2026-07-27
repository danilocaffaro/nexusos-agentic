import {
  ENGINE_COMPLETION_MAX_BYTES,
  parseEngineCompleteBody,
} from "./engine-complete-contract.mjs";
import {
  ENGINE_REPORT_MAX_BYTES,
  parseEngineReportBody,
} from "./engine-report-contract.mjs";

const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const RUNNER_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const ENGINE_REPORT_PATTERN = /^egr_[0-9a-f]{32}$/u;

const registry = Object.freeze({
  "engine.complete": Object.freeze({
    ackStatus: 200,
    bodyMaxBytes: ENGINE_COMPLETION_MAX_BYTES,
    bodyIdentity(body) {
      const completion = parseEngineCompleteBody(body);
      return completion
        ? { operationId: completion.operationId }
        : undefined;
    },
    identity(entry) {
      return RUN_PATTERN.test(entry.runId ?? "")
        ? { runId: entry.runId }
        : undefined;
    },
    pathname(entry) {
      return `/api/runs/${entry.runId}/engine-complete`;
    },
  }),
  "engine.report": Object.freeze({
    ackStatus: 201,
    bodyMaxBytes: ENGINE_REPORT_MAX_BYTES,
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
