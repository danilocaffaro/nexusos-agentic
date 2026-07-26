export function directConversationKey(principalIds: string[]): string {
  return Array.from(new Set(principalIds)).sort().join(":");
}
