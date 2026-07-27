import {
  AdmissionPolicyRepositoryError,
  getRunnerAdmissionPolicy,
  putRunnerAdmissionPolicy,
} from "@/src/adapters/d1/admission-policy-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runnerWorkspaceRoute(request, (identity) =>
    getRunnerAdmissionPolicy(identity),
  );
}

export async function PUT(request: Request) {
  return runnerWorkspaceRoute(
    request,
    (identity, input) =>
      putRunnerAdmissionPolicy(identity, input),
    200,
    () =>
      new AdmissionPolicyRepositoryError(
        "invalid_admission_policy",
        400,
      ),
  );
}
