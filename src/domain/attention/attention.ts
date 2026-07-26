export class AttentionTransitionError extends Error {
  constructor(readonly code: "attention_already_seen") {
    super("Only an open attention item can be marked as seen");
    this.name = "AttentionTransitionError";
  }
}

export function assertCanMarkAttentionSeen(status: "open" | "seen"): void {
  if (status !== "open") {
    throw new AttentionTransitionError("attention_already_seen");
  }
}
