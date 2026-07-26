export type DecisionPackageAccessEvent = {
  requestId: string;
  organizationId?: string;
  principalId?: string;
  intentId?: string;
  format?: "json" | "markdown";
  outcome: "success" | "denied" | "failed" | "changed";
  status: number;
  representationHash?: string;
  byteSize?: number;
  errorCode?: string;
};

export interface DecisionPackageAccessLogPort {
  record(event: DecisionPackageAccessEvent): void | Promise<void>;
}
