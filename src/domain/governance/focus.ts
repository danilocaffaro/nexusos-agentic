export function selectGovernanceIntent<T extends { id: string }>(
  intents: T[] | undefined,
  focusedIntentId: string,
): T | undefined {
  if (!intents) return undefined;
  return focusedIntentId
    ? intents.find((intent) => intent.id === focusedIntentId)
    : intents[0];
}
