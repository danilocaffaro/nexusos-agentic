"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationSummary } from "@/src/contracts/collaboration";
import type { PresenceStatus } from "@/src/contracts/presence";
import { usePresence } from "./presence-client";
import {
  occupantsForRoom,
  presenceInitials,
  summarizePresence,
} from "./presence-view-model";

const STATUS_LABELS: Record<PresenceStatus, string> = {
  available: "Disponível",
  focus: "Foco",
  dnd: "Não perturbe",
};

export function PersistentRoomsView({
  onMessage,
  notify,
}: {
  onMessage: (conversationId: string) => void;
  notify: (message: string) => void;
}) {
  const presence = usePresence();
  const [rooms, setRooms] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [roomsError, setRoomsError] = useState("");

  const loadRooms = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations", {
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as {
        conversations?: ConversationSummary[];
      };
      if (!response.ok || !body.conversations) {
        throw new Error("Salas temporariamente indisponíveis.");
      }
      const nextRooms = body.conversations.filter(
        (conversation) => conversation.kind === "room",
      );
      setRooms(nextRooms);
      setSelectedId((current) =>
        nextRooms.some((room) => room.id === current)
          ? current
          : nextRooms.find(
                (room) => room.id === presence.roomConversationId,
              )?.id ??
            nextRooms.find((room) => room.status === "active")?.id ??
            nextRooms[0]?.id ??
            "",
      );
      setRoomsError("");
    } catch (error) {
      setRoomsError(
        error instanceof Error
          ? error.message
          : "Salas temporariamente indisponíveis.",
      );
    } finally {
      setLoading(false);
    }
  }, [presence.roomConversationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRooms(), 0);
    window.addEventListener("nexus-conversations-changed", loadRooms);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("nexus-conversations-changed", loadRooms);
    };
  }, [loadRooms]);

  const summary = summarizePresence(presence.roster);
  const selected = rooms.find((room) => room.id === selectedId) ?? null;
  const selectedOccupants = useMemo(
    () => occupantsForRoom(presence.roster, selectedId),
    [presence.roster, selectedId],
  );
  const currentRoom = presence.passive
    ? undefined
    : rooms.find((room) => room.id === presence.roomConversationId);

  const enterSelectedRoom = () => {
    if (!selected || selected.status !== "active") return;
    presence.enterRoom(selected.id);
    notify(`Você entrou em ${selected.title}`);
  };

  const openSelectedChat = () => {
    if (!selected) return;
    if (selected.status === "active") presence.enterRoom(selected.id);
    onMessage(selected.id);
  };

  return (
    <div className="view-page rooms-page" data-testid="rooms-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">LIVE PRESENCE · REAL</span>
          <h1>Team Rooms</h1>
          <p>
            Veja quem está disponível e em qual sala compartilhada — nunca em
            DMs, prompts ou contexto privado.
          </p>
        </div>
        <div className="heading-actions presence-heading-actions">
          <label className="presence-status-control">
            <span>Meu status</span>
            <select
              value={presence.status}
              aria-label="Meu status de presence"
              disabled={presence.passive}
              title={
                presence.passive
                  ? "Assuma a presence nesta aba antes de alterar o status."
                  : undefined
              }
              onChange={(event) =>
                presence.updateStatus(event.target.value as PresenceStatus)
              }
            >
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="outline-button"
            disabled
            title="Capability opcional planejada; nenhum provedor de mídia é obrigatório."
          >
            Reunião · roadmap
          </button>
        </div>
      </div>

      {presence.passive && (
        <div className="presence-takeover" role="alert">
          <span>
            <b>Presence ativa em outra aba.</b>
            Esta aba observa o roster, mas não pulsa nem disputa o lease.
          </span>
          <button type="button" onClick={presence.takeOver}>
            Assumir nesta aba
          </button>
        </div>
      )}
      {(roomsError || presence.writeError || presence.rosterError) && (
        <div className="presence-warning" role="status">
          <span>
            {roomsError || presence.writeError || presence.rosterError}
          </span>
          <button
            type="button"
            onClick={() => {
              void loadRooms();
              presence.refreshRoster();
            }}
          >
            Atualizar
          </button>
        </div>
      )}

      <section className="presence-summary" aria-label="Resumo de presence">
        <div>
          <span className="presence-live" />
          <span>
            <small>ONLINE AGORA</small>
            <b>{summary.online} membros</b>
          </span>
        </div>
        <div>
          <small>HUMANOS</small>
          <b>{summary.humans}</b>
          <em>autodeclarado</em>
        </div>
        <div>
          <small>AGENTES</small>
          <b>{summary.agents}</b>
          <em>runner-auth only</em>
        </div>
        <div>
          <small>SALAS ATIVAS</small>
          <b>{summary.activeRooms}</b>
          <em>localização compartilhada</em>
        </div>
        <div>
          <small>FOCO / DND</small>
          <b>{summary.protectedFocus}</b>
          <em>sinal de apresentação</em>
        </div>
      </section>

      <div className="rooms-layout">
        <section className="virtual-office">
          <header>
            <div>
              <span className="eyebrow">WORKSPACE · TEAM FLOOR</span>
              <h2>Salas persistentes</h2>
            </div>
            <span className="presence-last-updated">
              {presence.rosterUpdatedAt
                ? `Roster ${relativeRosterTime(presence.rosterUpdatedAt)}`
                : "Sincronizando roster…"}
            </span>
          </header>
          <div className="office-map">
            {loading && <p className="rooms-empty">Carregando salas…</p>}
            {!loading && rooms.length === 0 && (
              <p className="rooms-empty">Nenhuma team room disponível.</p>
            )}
            {rooms.map((room, index) => {
              const occupants = occupantsForRoom(presence.roster, room.id);
              const selectedRoom = room.id === selectedId;
              const isCurrent =
                !presence.passive &&
                room.id === presence.roomConversationId;
              const tone = ["lime", "orange", "violet", "cyan"][index % 4];
              return (
                <button
                  key={room.id}
                  className={`room-card room-${tone} ${
                    selectedRoom ? "is-selected" : ""
                  } ${room.status === "archived" ? "is-archived" : ""}`}
                  aria-current={selectedRoom ? "true" : undefined}
                  onClick={() => setSelectedId(room.id)}
                >
                  <header>
                    <span>
                      <i /> {room.status === "active" ? "TEAM ROOM" : "ARQUIVADA"}
                    </span>
                    <em>{occupants.length} presentes</em>
                  </header>
                  <h3>{room.title}</h3>
                  <p>
                    {room.teamId ? "Contexto de time conectado" : "Sala do workspace"}
                    {isCurrent ? " · você está aqui" : ""}
                  </p>
                  <div className="room-members">
                    {occupants.slice(0, 5).map((entry) => (
                      <span
                        className={`presence-avatar status-${entry.status}`}
                        key={entry.principalId}
                        title={`${entry.displayName} · ${STATUS_LABELS[entry.status as PresenceStatus] ?? entry.status}`}
                      >
                        <i>{presenceInitials(entry.displayName)}</i>
                        <small>{entry.displayName}</small>
                      </span>
                    ))}
                    {occupants.length === 0 && (
                      <span className="room-empty-presence">
                        Ninguém publicou presença aqui
                      </span>
                    )}
                  </div>
                  <footer>
                    <span>⌁ contexto compartilhado</span>
                    <b>{isCurrent ? "Você está aqui" : "Selecionar →"}</b>
                  </footer>
                </button>
              );
            })}
          </div>
          <footer className="office-legend">
            <span>
              <i className="online" /> Disponível
            </span>
            <span>
              <i className="agent" /> Foco
            </span>
            <span>
              <i className="dnd" /> DND
            </span>
            <b>Sem histórico de tempo online; offline é derivado por TTL.</b>
          </footer>
        </section>

        <aside className="room-detail" aria-live="polite">
          {selected ? (
            <>
              <span className="eyebrow">SALA SELECIONADA</span>
              <div className="room-detail-title">
                <span className="room-monogram">{selected.title.slice(0, 1)}</span>
                <span>
                  <h2>{selected.title}</h2>
                  <p>
                    {selected.status === "active" ? "Ativa" : "Arquivada"} ·{" "}
                    {selected.members.filter((member) => member.status === "active").length}{" "}
                    membros
                  </p>
                </span>
              </div>
              <div className="room-now">
                <span>AGORA</span>
                <b>
                  {selectedOccupants.length
                    ? `${selectedOccupants.length} presentes`
                    : "Sala silenciosa"}
                </b>
                <small>
                  {currentRoom?.id === selected.id
                    ? "Sua localização publicada"
                    : "Entrar publica apenas o id desta sala"}
                </small>
              </div>
              <span className="eyebrow">QUEM ESTÁ AQUI</span>
              <div className="presence-list">
                {selectedOccupants.map((entry) => (
                  <button key={entry.principalId} onClick={openSelectedChat}>
                    <span className={`presence-avatar status-${entry.status}`}>
                      <i>{presenceInitials(entry.displayName)}</i>
                    </span>
                    <span>
                      <b>{entry.displayName}</b>
                      <small>
                        {principalLabel(entry.principalKind)} ·{" "}
                        {STATUS_LABELS[entry.status as PresenceStatus] ??
                          entry.status}
                      </small>
                    </span>
                    <em>chat →</em>
                  </button>
                ))}
                {selectedOccupants.length === 0 && (
                  <p className="rooms-empty">Nenhuma presença ativa.</p>
                )}
              </div>
              <div className="room-actions">
                {!presence.passive &&
                presence.roomConversationId === selected.id ? (
                  <button
                    className="outline-button"
                    type="button"
                    disabled={presence.passive}
                    onClick={() => {
                      presence.leaveRoom();
                      notify(`Você saiu de ${selected.title}`);
                    }}
                  >
                    Sair da sala
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      selected.status !== "active" || presence.passive
                    }
                    onClick={enterSelectedRoom}
                  >
                    Entrar na sala
                  </button>
                )}
                <button
                  className="outline-button"
                  type="button"
                  onClick={openSelectedChat}
                >
                  Abrir chat da sala
                </button>
              </div>
              <div className="drop-in-note">
                <b>Mídia é capability opcional</b>
                <p>
                  Chat já é persistente. Áudio e vídeo entrarão por provider
                  plugável, com consentimento e sem dependência do core.
                </p>
                <button type="button" disabled>
                  Knock / call · roadmap
                </button>
              </div>
            </>
          ) : (
            <p className="rooms-empty">Selecione uma sala.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function relativeRosterTime(value: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000));
  if (seconds < 2) return "agora";
  if (seconds < 60) return `há ${seconds}s`;
  return `há ${Math.round(seconds / 60)}m`;
}

function principalLabel(kind: string): string {
  const labels: Record<string, string> = {
    human: "Humano",
    agent: "Agente",
    automation: "Automação",
    policy: "Policy",
    runner: "Runner",
  };
  return labels[kind] ?? kind;
}
