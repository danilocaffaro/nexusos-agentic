import { env } from "cloudflare:workers";
import {
  resolvePromptCipherKeyring,
  WebCryptoPromptCipher,
} from "@/src/adapters/crypto/web-crypto-prompt-cipher";
import { createEngineRun } from "@/src/adapters/d1/run-repository";
import {
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import {
  RUNNER_PRIVATE_HEADERS,
  runnerRouteError,
} from "@/src/adapters/http/runner-route";
import {
  parseEngineRunCreateRequest,
  readBoundedEngineRunRequest,
} from "@/src/domain/runners/engine-control-plane";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const identity = requireRequestIdentity(request);
    const raw = await readBoundedEngineRunRequest(request);
    const input = await parseEngineRunCreateRequest(raw);
    const keyring = resolvePromptCipherKeyring({
      allowLocalIdentity: env.NEXUS_ALLOW_LOCAL_IDENTITY === "1",
      serialized: env.NEXUS_PROMPT_CIPHER_KEYS,
    });
    const result = await createEngineRun(
      identity,
      input,
      new WebCryptoPromptCipher(keyring),
    );
    return Response.json(result, {
      status: 201,
      headers: RUNNER_PRIVATE_HEADERS,
    });
  } catch (error) {
    return runnerRouteError(error);
  }
}
