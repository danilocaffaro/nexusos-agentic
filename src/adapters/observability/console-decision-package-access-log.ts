import type {
  DecisionPackageAccessEvent,
  DecisionPackageAccessLogPort,
} from "@/src/ports/decision-package-access-log";

export const decisionPackageAccessLog: DecisionPackageAccessLogPort = {
  record(event: DecisionPackageAccessEvent) {
    try {
      console.info(
        "[decision-package-access]",
        JSON.stringify(event),
      );
    } catch {
      // Operational logging is best effort and cannot block an authorized read.
    }
  },
};
