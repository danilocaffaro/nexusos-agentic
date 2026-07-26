import type {
  PresenceEntry,
  PresenceRoster,
} from "@/src/contracts/presence";

export function summarizePresence(roster: PresenceRoster | null) {
  const entries = roster?.entries ?? [];
  const online = entries.filter((entry) => entry.status !== "offline");
  return {
    online: online.length,
    humans: online.filter((entry) => entry.principalKind === "human").length,
    agents: online.filter((entry) => entry.principalKind === "agent").length,
    activeRooms: new Set(
      online.flatMap((entry) =>
        entry.room ? [entry.room.conversationId] : [],
      ),
    ).size,
    protectedFocus: online.filter(
      (entry) => entry.status === "focus" || entry.status === "dnd",
    ).length,
  };
}

export function occupantsForRoom(
  roster: PresenceRoster | null,
  conversationId: string,
): PresenceEntry[] {
  return (roster?.entries ?? []).filter(
    (entry) =>
      entry.status !== "offline" &&
      entry.room?.conversationId === conversationId,
  );
}

export function presenceInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("pt-BR"))
    .join("");
}
