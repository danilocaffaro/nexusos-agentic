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
import type { ReactNode } from "react";
import type { RealtimeWireSignal } from "@/src/contracts/realtime";
import {
  INVALID_REALTIME_FRAME_CLOSE_CODE,
  parseRealtimeFrame,
  reconnectDelayMs,
  RealtimeSignalBuffer,
  type RealtimeClientEvent,
  type RealtimeClientStatus,
} from "./realtime-policy";

type RealtimeListener = (event: RealtimeClientEvent) => void;

type RealtimeContextValue = {
  status: RealtimeClientStatus;
  live: boolean;
  subscribe: (listener: RealtimeListener) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);
const PROBE_RETRY_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_MS = 30_000;
const SIGNAL_DEBOUNCE_MS = 250;
const SIGNAL_MAX_WAIT_MS = 1_000;
const REAUTH_BASE_MS = 25 * 60_000;
const REAUTH_JITTER_MS = 2 * 60_000;
const INVALID_FRAME_LIMIT = 3;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RealtimeClientStatus>("probing");
  const listenersRef = useRef(new Set<RealtimeListener>());

  const subscribe = useCallback((listener: RealtimeListener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  useEffect(() => {
    let active = true;
    let generation = 0;
    let featureSupported = false;
    let failureAttempt = 0;
    let invalidFrames = 0;
    let socket: WebSocket | null = null;
    let probeTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let connectTimer: number | undefined;
    let pingTimer: number | undefined;
    let pongTimer: number | undefined;
    let stableTimer: number | undefined;
    let reauthTimer: number | undefined;
    let signalTimer: number | undefined;
    let signalMaxTimer: number | undefined;
    let resyncDirty = false;
    let probing = false;
    const signalBuffer = new RealtimeSignalBuffer();

    const updateStatus = (nextStatus: RealtimeClientStatus) => {
      if (!active) return;
      setStatus(nextStatus);
      window.dispatchEvent(
        new CustomEvent("nexus-realtime-status", {
          detail: { status: nextStatus },
        }),
      );
    };

    const emit = (event: RealtimeClientEvent) => {
      if (!active) return;
      for (const listener of listenersRef.current) {
        try {
          listener(event);
        } catch {
          // One view cannot prevent other domains from resynchronizing.
        }
      }
      if (event.kind === "resync") {
        window.dispatchEvent(new Event("nexus-conversations-changed"));
        window.dispatchEvent(new Event("nexus-attention-changed"));
        window.dispatchEvent(new Event("nexus-presence-changed"));
      } else if (event.kind === "conversation") {
        window.dispatchEvent(new Event("nexus-conversations-changed"));
      } else if (event.kind === "attention") {
        window.dispatchEvent(new Event("nexus-attention-changed"));
      } else {
        window.dispatchEvent(new Event("nexus-presence-changed"));
      }
    };

    const flushSignals = () => {
      window.clearTimeout(signalTimer);
      window.clearTimeout(signalMaxTimer);
      signalTimer = undefined;
      signalMaxTimer = undefined;
      if (!active || document.hidden) return;
      for (const signal of signalBuffer.drain()) emit(signal);
    };

    const enqueueSignal = (signal: RealtimeWireSignal) => {
      signalBuffer.add(signal);
      if (document.hidden) return;
      window.clearTimeout(signalTimer);
      signalTimer = window.setTimeout(flushSignals, SIGNAL_DEBOUNCE_MS);
      if (signalMaxTimer === undefined) {
        signalMaxTimer = window.setTimeout(flushSignals, SIGNAL_MAX_WAIT_MS);
      }
    };

    const clearConnectionTimers = () => {
      window.clearTimeout(connectTimer);
      window.clearTimeout(pingTimer);
      window.clearTimeout(pongTimer);
      window.clearTimeout(stableTimer);
      window.clearTimeout(reauthTimer);
      connectTimer = undefined;
      pingTimer = undefined;
      pongTimer = undefined;
      stableTimer = undefined;
      reauthTimer = undefined;
    };

    const closeCurrentSocket = (reason: string) => {
      clearConnectionTimers();
      const current = socket;
      socket = null;
      if (
        current &&
        (current.readyState === WebSocket.OPEN ||
          current.readyState === WebSocket.CONNECTING)
      ) {
        try {
          current.close(1000, reason.slice(0, 123));
        } catch {
          // A concurrent close is already converged.
        }
      }
    };

    const socketUrl = () => {
      const url = new URL("/api/realtime/socket", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    };

    const schedulePing = (currentGeneration: number, immediate = false) => {
      window.clearTimeout(pingTimer);
      pingTimer = window.setTimeout(
        () => {
          if (
            !active ||
            currentGeneration !== generation ||
            document.hidden ||
            !socket ||
            socket.readyState !== WebSocket.OPEN
          ) {
            schedulePing(currentGeneration);
            return;
          }
          try {
            socket.send("ping");
          } catch {
            socket.close();
            return;
          }
          window.clearTimeout(pongTimer);
          pongTimer = window.setTimeout(() => {
            if (
              active &&
              currentGeneration === generation &&
              socket?.readyState === WebSocket.OPEN
            ) {
              socket.close(4000, "pong_timeout");
            }
          }, PONG_TIMEOUT_MS);
          schedulePing(currentGeneration);
        },
        immediate ? 0 : PING_INTERVAL_MS,
      );
    };

    const connect = () => {
      if (!active || !featureSupported) return;
      const currentGeneration = ++generation;
      window.clearTimeout(reconnectTimer);
      closeCurrentSocket("reconnect");
      updateStatus("connecting");
      invalidFrames = 0;
      const nextSocket = new WebSocket(socketUrl());
      socket = nextSocket;
      connectTimer = window.setTimeout(() => {
        if (
          active &&
          currentGeneration === generation &&
          nextSocket.readyState !== WebSocket.OPEN
        ) {
          nextSocket.close();
        }
      }, CONNECT_TIMEOUT_MS);

      nextSocket.onopen = () => {
        if (
          !active ||
          currentGeneration !== generation ||
          socket !== nextSocket
        ) {
          nextSocket.close();
          return;
        }
        window.clearTimeout(connectTimer);
        updateStatus("live");
        if (document.hidden) resyncDirty = true;
        else emit({ kind: "resync" });
        stableTimer = window.setTimeout(() => {
          if (
            active &&
            currentGeneration === generation &&
            socket === nextSocket
          ) {
            failureAttempt = 0;
          }
        }, STABLE_CONNECTION_MS);
        reauthTimer = window.setTimeout(() => {
          if (
            active &&
            currentGeneration === generation &&
            socket === nextSocket
          ) {
            failureAttempt = 0;
            connect();
          }
        }, REAUTH_BASE_MS + Math.floor(Math.random() * REAUTH_JITTER_MS));
        schedulePing(currentGeneration);
      };

      nextSocket.onmessage = (message) => {
        if (
          !active ||
          currentGeneration !== generation ||
          socket !== nextSocket
        ) {
          return;
        }
        const parsed = parseRealtimeFrame(message.data);
        if (parsed.kind === "pong") {
          invalidFrames = 0;
          window.clearTimeout(pongTimer);
          pongTimer = undefined;
          return;
        }
        if (parsed.kind === "invalid") {
          invalidFrames += 1;
          if (invalidFrames >= INVALID_FRAME_LIMIT) {
            nextSocket.close(
              INVALID_REALTIME_FRAME_CLOSE_CODE,
              "invalid_realtime_frames",
            );
          }
          return;
        }
        invalidFrames = 0;
        enqueueSignal(parsed.signal);
      };

      nextSocket.onerror = () => {
        if (
          active &&
          currentGeneration === generation &&
          socket === nextSocket
        ) {
          nextSocket.close();
        }
      };

      nextSocket.onclose = () => {
        if (
          !active ||
          currentGeneration !== generation ||
          socket !== nextSocket
        ) {
          return;
        }
        clearConnectionTimers();
        socket = null;
        updateStatus("reconnect_wait");
        const delay = reconnectDelayMs(failureAttempt);
        failureAttempt += 1;
        if (failureAttempt >= 3) {
          featureSupported = false;
          reconnectTimer = window.setTimeout(() => void probe(), delay);
        } else {
          reconnectTimer = window.setTimeout(connect, delay);
        }
      };
    };

    const probe = async (allowAuthRefresh = true) => {
      if (!active || probing) return;
      probing = true;
      window.clearTimeout(probeTimer);
      updateStatus("probing");
      try {
        let canRefreshAuth = allowAuthRefresh;
        while (active) {
          const response = await fetch("/api/realtime/socket", {
            cache: "no-store",
          });
          if (!active) return;
          if (response.status === 426) {
            featureSupported = true;
            connect();
            return;
          }
          if (response.status === 401 && canRefreshAuth) {
            canRefreshAuth = false;
            await fetch("/api/workspace", { cache: "no-store" }).catch(
              () => undefined,
            );
            continue;
          }
          break;
        }
      } catch {
        // Any probe failure preserves the polling correctness floor.
      } finally {
        probing = false;
      }
      if (!active || socket) return;
      featureSupported = false;
      closeCurrentSocket("polling_fallback");
      updateStatus("fallback");
      probeTimer = window.setTimeout(() => void probe(), PROBE_RETRY_MS);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        window.clearTimeout(pingTimer);
        window.clearTimeout(pongTimer);
        pingTimer = undefined;
        pongTimer = undefined;
        return;
      }
      if (resyncDirty) {
        resyncDirty = false;
        emit({ kind: "resync" });
      }
      flushSignals();
      if (socket?.readyState === WebSocket.OPEN) {
        schedulePing(generation, true);
      } else if (!featureSupported) {
        void probe();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    void probe();
    return () => {
      active = false;
      generation += 1;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearTimeout(probeTimer);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(signalTimer);
      window.clearTimeout(signalMaxTimer);
      closeCurrentSocket("provider_unmounted");
    };
  }, []);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      status,
      live: status === "live",
      subscribe,
    }),
    [status, subscribe],
  );

  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  const value = useContext(RealtimeContext);
  if (!value) {
    throw new Error("useRealtime must be used inside RealtimeProvider");
  }
  return value;
}
