"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MutableRefObject, ReactNode } from "react";
import type {
  PresenceRoster,
  PresenceSessionCommand,
  PresenceSessionLease,
  PresenceStatus,
} from "@/src/contracts/presence";
import { useRealtime } from "./realtime-client";
import { pollingDelayMs } from "./realtime-policy";

type PresenceContextValue = {
  roster: PresenceRoster | null;
  status: PresenceStatus;
  roomConversationId: string | null;
  passive: boolean;
  writeError: string;
  rosterError: string;
  rosterUpdatedAt: number | null;
  updateStatus: (status: PresenceStatus) => void;
  enterRoom: (conversationId: string) => void;
  leaveRoom: () => void;
  takeOver: () => void;
  refreshRoster: () => void;
};

const PresenceContext = createContext<PresenceContextValue | null>(null);
const ROOM_STORAGE = "nexus:presence:room";
const STATUS_STORAGE = "nexus:presence:status";

export function PresenceProvider({ children }: { children: ReactNode }) {
  const {
    status: realtimeStatus,
    subscribe: subscribeRealtime,
  } = useRealtime();
  const [roster, setRoster] = useState<PresenceRoster | null>(null);
  const [status, setStatus] = useState<PresenceStatus>("available");
  const [roomConversationId, setRoomConversationId] = useState<string | null>(
    null,
  );
  const [lease, setLease] = useState<PresenceSessionLease | null>(null);
  const [passive, setPassive] = useState(false);
  const [writeError, setWriteError] = useState("");
  const [rosterError, setRosterError] = useState("");
  const [rosterUpdatedAt, setRosterUpdatedAt] = useState<number | null>(null);
  const activeRef = useRef(false);
  const statusRef = useRef<PresenceStatus>("available");
  const roomRef = useRef<string | null>(null);
  const sessionKeyRef = useRef("");
  const fencingTokenRef = useRef<number | null>(null);
  const writeRunningRef = useRef(false);
  const writePendingRef = useRef(false);
  const forceTakeoverRef = useRef(false);
  const refreshRosterRef = useRef<() => void>(() => undefined);
  const realtimeStatusRef = useRef(realtimeStatus);

  useEffect(() => {
    realtimeStatusRef.current = realtimeStatus;
  }, [realtimeStatus]);

  const runPresenceWrite = useCallback(async () => {
    if (writeRunningRef.current || !activeRef.current) return;
    writeRunningRef.current = true;
    try {
      do {
        writePendingRef.current = false;
        const forceTakeover = forceTakeoverRef.current;
        forceTakeoverRef.current = false;
        const sessionKey = ensureSessionKey(sessionKeyRef);
        const payload = buildPresenceSessionPayload({
          sessionKey,
          status: statusRef.current,
          roomConversationId: roomRef.current,
          fencingToken: fencingTokenRef.current,
          takeover: forceTakeover,
        });
        try {
          const response = await fetch("/api/presence/session", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const body = (await response.json().catch(() => ({}))) as
            | PresenceSessionLease
            | { error?: string };
          if (response.status === 409) {
            if (activeRef.current) {
              setPassive(true);
              setLease(null);
              setWriteError(
                "Outra aba ou dispositivo assumiu sua presença. Nada será retomado sem sua confirmação.",
              );
            }
            break;
          }
          if (!response.ok || !("fencingToken" in body)) {
            throw new Error(
              presenceErrorLabel(
                "error" in body
                  ? body.error ?? "presence_operation_failed"
                  : "presence_operation_failed",
              ),
            );
          }
          fencingTokenRef.current = body.fencingToken;
          if (body.roomCleared && roomRef.current !== null) {
            roomRef.current = null;
            setRoomConversationId(null);
            removeSessionValue(ROOM_STORAGE);
          }
          if (activeRef.current) {
            setLease(body);
            setPassive(false);
            setWriteError("");
          }
          refreshRosterRef.current();
        } catch (error) {
          if (activeRef.current) {
            setWriteError(
              error instanceof Error
                ? error.message
                : "Presence temporariamente indisponível.",
            );
            setLease(null);
          }
          break;
        }
      } while (writePendingRef.current && activeRef.current);
    } finally {
      writeRunningRef.current = false;
    }
  }, []);

  const queuePresenceWrite = useCallback(() => {
    writePendingRef.current = true;
    void runPresenceWrite();
  }, [runPresenceWrite]);

  const queuePresenceTakeover = useCallback(
    () => {
      writePendingRef.current = true;
      forceTakeoverRef.current = true;
      void runPresenceWrite();
    },
    [runPresenceWrite],
  );

  useEffect(() => {
    activeRef.current = true;
    const timer = window.setTimeout(() => {
      const storedStatus = readLocalStatus();
      const storedRoom = readSessionValue(ROOM_STORAGE);
      statusRef.current = storedStatus;
      roomRef.current = storedRoom;
      fencingTokenRef.current = null;
      setStatus(storedStatus);
      setRoomConversationId(storedRoom);
      queuePresenceWrite();
    }, 0);

    const release = () => {
      const sessionKey = sessionKeyRef.current;
      const fencingToken = fencingTokenRef.current;
      removeSessionValue(ROOM_STORAGE);
      if (!sessionKey || fencingToken === null) return;
      void fetch("/api/presence/session", {
        method: "DELETE",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, fencingToken }),
      });
    };
    window.addEventListener("pagehide", release);
    return () => {
      activeRef.current = false;
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", release);
    };
  }, [queuePresenceWrite]);

  useEffect(() => {
    if (passive || !lease) return;
    const timer = window.setTimeout(
      () => queuePresenceWrite(),
      lease.heartbeatSeconds * 1_000,
    );
    return () => window.clearTimeout(timer);
  }, [lease, passive, queuePresenceWrite]);

  useEffect(() => {
    if (passive || lease || !writeError) return;
    const timer = window.setTimeout(() => queuePresenceWrite(), 10_000);
    return () => window.clearTimeout(timer);
  }, [lease, passive, queuePresenceWrite, writeError]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    let pulling = false;
    let pendingDirty = false;
    const schedule = () => {
      if (!active) return;
      const baseDelay = document.hidden ? 30_000 : 5_000;
      timer = window.setTimeout(
        pull,
        pollingDelayMs({
          status: realtimeStatusRef.current,
          baseDelayMs: baseDelay,
          failureCount: failures,
          maximumDelayMs: 60_000,
          liveDelayMs: 15_000,
        }),
      );
    };
    const pull = async () => {
      if (!active) return;
      if (pulling) {
        pendingDirty = true;
        return;
      }
      if (document.hidden) {
        pendingDirty = true;
        return;
      }
      pulling = true;
      pendingDirty = false;
      try {
        const response = await fetch("/api/presence", { cache: "no-store" });
        const body = (await response.json().catch(() => ({}))) as
          | PresenceRoster
          | { error?: string };
        if (!response.ok || !("entries" in body)) {
          throw new Error("Roster temporariamente indisponível.");
        }
        if (!active) return;
        failures = 0;
        setRoster(body);
        setRosterUpdatedAt(Date.now());
        setRosterError("");
      } catch (error) {
        if (!active) return;
        failures += 1;
        setRosterError(
          error instanceof Error
            ? error.message
            : "Roster temporariamente indisponível.",
        );
      } finally {
        pulling = false;
        if (pendingDirty && active && !document.hidden) {
          pendingDirty = false;
          void pull();
        } else if (!document.hidden) {
          schedule();
        }
      }
    };
    const refresh = () => {
      pendingDirty = true;
      if (document.hidden || pulling) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void pull();
    };
    refreshRosterRef.current = refresh;
    const handleVisibility = () => {
      if (!document.hidden) refresh();
    };
    const unsubscribe = subscribeRealtime((event) => {
      if (event.kind === "presence" || event.kind === "resync") refresh();
    });
    void pull();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      unsubscribe();
      refreshRosterRef.current = () => undefined;
    };
  }, [subscribeRealtime]);

  const updateStatus = useCallback(
    (nextStatus: PresenceStatus) => {
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      storeLocalValue(STATUS_STORAGE, nextStatus);
      if (!passive) queuePresenceWrite();
    },
    [passive, queuePresenceWrite],
  );

  const enterRoom = useCallback(
    (conversationId: string) => {
      if (!conversationId || roomRef.current === conversationId) return;
      roomRef.current = conversationId;
      setRoomConversationId(conversationId);
      storeSessionValue(ROOM_STORAGE, conversationId);
      if (!passive) queuePresenceWrite();
    },
    [passive, queuePresenceWrite],
  );

  const leaveRoom = useCallback(() => {
    if (roomRef.current === null) return;
    roomRef.current = null;
    setRoomConversationId(null);
    removeSessionValue(ROOM_STORAGE);
    if (!passive) queuePresenceWrite();
  }, [passive, queuePresenceWrite]);

  const takeOver = useCallback(
    () => queuePresenceTakeover(),
    [queuePresenceTakeover],
  );

  const value = useMemo<PresenceContextValue>(
    () => ({
      roster,
      status,
      roomConversationId,
      passive,
      writeError,
      rosterError,
      rosterUpdatedAt,
      updateStatus,
      enterRoom,
      leaveRoom,
      takeOver,
      refreshRoster: () => refreshRosterRef.current(),
    }),
    [
      enterRoom,
      leaveRoom,
      passive,
      roomConversationId,
      roster,
      rosterError,
      rosterUpdatedAt,
      status,
      takeOver,
      updateStatus,
      writeError,
    ],
  );

  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence(): PresenceContextValue {
  const value = useContext(PresenceContext);
  if (!value) {
    throw new Error("usePresence must be used inside PresenceProvider");
  }
  return value;
}

function ensureSessionKey(ref: MutableRefObject<string>): string {
  if (ref.current) return ref.current;
  ref.current = crypto.randomUUID();
  return ref.current;
}

export function buildPresenceSessionPayload(input: {
  sessionKey: string;
  status: PresenceStatus;
  roomConversationId: string | null;
  fencingToken: number | null;
  takeover: boolean;
}): PresenceSessionCommand {
  const payload: PresenceSessionCommand = {
    sessionKey: input.sessionKey,
    status: input.status,
    roomConversationId: input.roomConversationId,
  };
  if (input.takeover) {
    payload.takeover = true;
  } else if (input.fencingToken !== null) {
    payload.fencingToken = input.fencingToken;
  }
  return payload;
}

function readLocalStatus(): PresenceStatus {
  try {
    const stored = window.localStorage.getItem(STATUS_STORAGE);
    return stored === "focus" || stored === "dnd" ? stored : "available";
  } catch {
    return "available";
  }
}

function readSessionValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeSessionValue(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Storage is an optimization; the lease remains authoritative.
  }
}

function removeSessionValue(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Best effort.
  }
}

function storeLocalValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The self-declared status can safely fall back to the current tab.
  }
}

function presenceErrorLabel(code: string): string {
  const labels: Record<string, string> = {
    presence_invalid_room:
      "A sala deixou de ser publicável; sua localização foi limpa.",
    presence_invalid_session:
      "A sessão de presence foi rejeitada e será renovada com segurança.",
    workspace_membership_required:
      "Sua membership não permite publicar presence neste workspace.",
  };
  return labels[code] ?? "Presence temporariamente indisponível.";
}
