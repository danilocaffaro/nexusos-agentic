export const PROMPT_CIPHER_VERSION = 1 as const;
export const PROMPT_CIPHER_IV_BYTES = 12;
export const PROMPT_CIPHER_TAG_BYTES = 16;

export type PromptCipherContext = {
  organizationId: string;
  promptRef: string;
  runId: string;
};

export type PromptCipherEnvelope = {
  cipherVersion: typeof PROMPT_CIPHER_VERSION;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyId: string;
  tag: Uint8Array;
};

export interface PromptCipher {
  decrypt(
    envelope: PromptCipherEnvelope,
    context: PromptCipherContext,
  ): Promise<Uint8Array>;
  encrypt(
    plaintext: Uint8Array,
    context: PromptCipherContext,
  ): Promise<PromptCipherEnvelope>;
}
