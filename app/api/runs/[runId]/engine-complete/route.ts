import { env } from "cloudflare:workers";
import {
  resolvePromptCipherKeyring,
  WebCryptoPromptCipher,
} from "@/src/adapters/crypto/web-crypto-prompt-cipher";
import { completeEngineRun } from "@/src/adapters/d1/run-repository";
import {
  scheduleMutationDeadlineReconciliation,
} from "@/src/adapters/d1/schedule-deadline-reconciliation";
import { signedRunRoute } from "@/src/adapters/http/signed-run-route";
import { parseEngineCompleteBody } from "@/src/domain/runners/execution-engine";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return signedRunRoute({
    request,
    runId,
    domain: "nexus-runner-engine-complete-v1",
    parse: parseEngineCompleteBody,
    handle: async (body, signed) => {
      const result = await completeEngineRun({
        ...signed,
        fence: body.fence,
        leaseId: body.leaseId,
        operationId: body.operationId,
        operationRequestHash: signed.operationRequestHash,
        receipt: body.receipt,
        resolveCipher: () => {
          const keyring = resolvePromptCipherKeyring({
            allowLocalIdentity: env.NEXUS_ALLOW_LOCAL_IDENTITY === "1",
            serialized: env.NEXUS_PROMPT_CIPHER_KEYS,
          });
          return new WebCryptoPromptCipher(keyring);
        },
      });
      scheduleMutationDeadlineReconciliation();
      return result;
    },
  });
}
