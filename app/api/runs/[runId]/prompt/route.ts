import { env } from "cloudflare:workers";
import {
  resolvePromptCipherKeyring,
  WebCryptoPromptCipher,
} from "@/src/adapters/crypto/web-crypto-prompt-cipher";
import { readEnginePromptForLease } from "@/src/adapters/d1/run-repository";
import {
  signedEnginePromptReadRoute,
} from "@/src/adapters/http/signed-prompt-read-route";
import {
  parseEnginePromptReadBody,
} from "@/src/domain/runners/engine-control-plane";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return signedEnginePromptReadRoute({
    request,
    runId,
    parse: parseEnginePromptReadBody,
    handle: (body, signed) => {
      const keyring = resolvePromptCipherKeyring({
        allowLocalIdentity: env.NEXUS_ALLOW_LOCAL_IDENTITY === "1",
        serialized: env.NEXUS_PROMPT_CIPHER_KEYS,
      });
      return readEnginePromptForLease({
        ...signed,
        fence: body.fence,
        leaseId: body.leaseId,
        promptRef: body.promptRef,
        cipher: new WebCryptoPromptCipher(keyring),
      });
    },
  });
}
