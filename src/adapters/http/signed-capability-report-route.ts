import type {
  SignedCapabilityReportResult,
} from "@/src/adapters/d1/capability-report-repository";
import {
  signedDeclarationRoute,
  type SignedDeclarationContext,
} from "@/src/adapters/http/signed-declaration-route";

export type SignedCapabilityReportContext = SignedDeclarationContext;

export function signedCapabilityReportRoute<T>(input: {
  request: Request;
  runnerId: string;
  parse: (raw: Uint8Array) => T | undefined;
  handle: (
    body: T,
    context: SignedCapabilityReportContext,
  ) => Promise<SignedCapabilityReportResult>;
}): Promise<Response> {
  return signedDeclarationRoute({
    ...input,
    domain: "nexus-runner-capability-report-v1",
    failureCode: "capability_report_failed",
  });
}
