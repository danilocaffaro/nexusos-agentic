"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ConversationMessage,
  ConversationSummary,
} from "@/src/contracts/collaboration";

type WorkspaceForMessages = {
  projects: Array<{
    id: string;
    name: string;
    status: "active" | "paused" | "archived";
  }>;
  teams: Array<{
    id: string;
    project_id: string;
    name: string;
    status: "active" | "paused" | "archived";
  }>;
  agents: Array<{
    id: string;
    principal_id: string;
    name: string;
    role: string;
    status: "active" | "paused" | "archived";
  }>;
  workItems: Array<{
    id: string;
    project_id: string;
    ref: string;
    title: string;
    status: string;
  }>;
};

type ConversationMode = "direct" | "room" | "handoff";

const MODE_LABELS: Record<ConversationMode, string> = {
  direct: "Direct",
  room: "Rooms",
  handoff: "Handoffs",
};

export function PersistentMessagesView({
  onProject,
  onOutput,
  notify,
  workspace,
  drafts,
  onDraftChange,
}: {
  onProject: () => void;
  onOutput: () => void;
  notify: (message: string) => void;
  workspace: WorkspaceForMessages | null;
  drafts: Record<string, string>;
  onDraftChange: (conversationId: string, value: string) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [conversationMode, setConversationMode] =
    useState<ConversationMode>("direct");
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pollError, setPollError] = useState("");
  const [actionError, setActionError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loadedConversationId, setLoadedConversationId] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const [createDraft, setCreateDraft] = useState(() =>
    emptyConversationDraft(),
  );
  const sequenceRef = useRef(0);
  const selectedIdRef = useRef("");
  const conversationModeRef = useRef<ConversationMode>("direct");
  const loadedConversationIdRef = useRef("");
  const autoScrollRef = useRef(true);
  const creatingRef = useRef(false);
  const retryingConversationListRef = useRef(false);
  const threadBodyRef = useRef<HTMLDivElement | null>(null);
  const createDialogRef = useRef<HTMLFormElement | null>(null);

  const refreshConversations = useCallback(async () => {
    const response = await fetch("/api/conversations", {
      cache: "no-store",
    });
    const body = (await response.json()) as
      | { conversations: ConversationSummary[] }
      | { error: string };
    if (!response.ok || !("conversations" in body)) {
      throw new Error(
        "error" in body ? collaborationError(body.error) : "Conversas indisponíveis.",
      );
    }
    setConversations(body.conversations);
    setLoadError("");
    return body.conversations;
  }, []);

  const selectConversation = useCallback((conversationId: string) => {
    if (selectedIdRef.current === conversationId) return;
    selectedIdRef.current = conversationId;
    loadedConversationIdRef.current = "";
    sequenceRef.current = 0;
    autoScrollRef.current = true;
    setSelectedId(conversationId);
    setLoadedConversationId("");
    setMessages([]);
    setPollError("");
    setActionError("");
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void refreshConversations()
        .then((loadedConversations) => {
          if (!active) return;
          setLoadError("");
          selectConversation(
            conversationIdForMode(
              loadedConversations,
              conversationModeRef.current,
              selectedIdRef.current,
            ),
          );
        })
        .catch((reason: unknown) => {
          if (active) {
            setLoadError(
              reason instanceof Error
                ? reason.message
                : "Conversas indisponíveis.",
            );
          }
        })
        .finally(() => {
          if (active) setLoadingConversations(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refreshConversations, selectConversation]);

  useEffect(() => {
    if (!selectedId) {
      sequenceRef.current = 0;
      loadedConversationIdRef.current = "";
      return;
    }
    let active = true;
    let pulling = false;
    let consecutiveFailures = 0;
    let timer: number | undefined;

    const scheduleNextPull = () => {
      if (!active) return;
      const delay = Math.min(
        4_000 * 2 ** Math.max(0, consecutiveFailures - 1),
        60_000,
      );
      timer = window.setTimeout(() => void pull(), delay);
    };

    const pull = async () => {
      if (!active || pulling) return;
      if (document.hidden) {
        scheduleNextPull();
        return;
      }
      pulling = true;
      try {
        const replace = loadedConversationIdRef.current !== selectedId;
        const afterSequence = replace ? 0 : sequenceRef.current;
        const response = await fetch(
          `/api/conversations/${selectedId}/messages?afterSequence=${afterSequence}`,
          { cache: "no-store" },
        );
        const body = (await response.json()) as
          | { messages: ConversationMessage[]; nextSequence: number }
          | { error: string };
        if (!response.ok || !("messages" in body)) {
          throw new Error(
            "error" in body
              ? collaborationError(body.error)
              : "Mensagens indisponíveis.",
          );
        }
        if (!active) return;
        sequenceRef.current = Math.max(
          sequenceRef.current,
          body.nextSequence,
        );
        setMessages((current) =>
          replace
            ? mergeMessages(body.messages, current)
            : mergeMessages(current, body.messages),
        );
        if (replace) {
          loadedConversationIdRef.current = selectedId;
          setLoadedConversationId(selectedId);
        }
        consecutiveFailures = 0;
        setPollError("");
      } catch (reason) {
        if (active) {
          consecutiveFailures += 1;
          setPollError(
            reason instanceof Error
              ? reason.message
              : "Mensagens indisponíveis.",
          );
        }
      } finally {
        pulling = false;
        scheduleNextPull();
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden || pulling) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void pull();
    };

    void pull();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [retryToken, selectedId]);

  useEffect(() => {
    const body = threadBodyRef.current;
    if (body && autoScrollRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [messages.length, selectedId]);

  useEffect(() => {
    if (!createOpen) return;
    const dialog = createDialogRef.current;
    if (!dialog) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    dialog.querySelector<HTMLElement>(focusableSelector)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (creatingRef.current) return;
        event.preventDefault();
        setCreateOpen(false);
        return;
      }
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (event.key !== "Tab" || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [createOpen]);

  const selectedConversation =
    conversations.find((conversation) => conversation.id === selectedId) ??
    null;
  const draft = selectedId ? drafts[selectedId] ?? "" : "";
  const loadingMessages =
    Boolean(selectedId) && loadedConversationId !== selectedId;
  const visibleConversations = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
    return conversations.filter(
      (conversation) =>
        conversation.kind === conversationMode &&
        (!normalizedSearch ||
          conversation.title
            .toLocaleLowerCase("pt-BR")
            .includes(normalizedSearch) ||
          conversation.members.some((member) =>
            member.displayName
              .toLocaleLowerCase("pt-BR")
              .includes(normalizedSearch),
          )),
    );
  }, [conversationMode, conversations, search]);

  const chooseMode = (mode: ConversationMode) => {
    conversationModeRef.current = mode;
    setConversationMode(mode);
    selectConversation(
      conversationIdForMode(conversations, mode, selectedIdRef.current),
    );
  };

  const retryConversationList = () => {
    if (retryingConversationListRef.current) return;
    retryingConversationListRef.current = true;
    setLoadingConversations(true);
    setLoadError("");
    void refreshConversations()
      .then((loadedConversations) => {
        selectConversation(
          conversationIdForMode(
            loadedConversations,
            conversationModeRef.current,
            selectedIdRef.current,
          ),
        );
      })
      .catch((reason: unknown) => {
        setLoadError(
          reason instanceof Error ? reason.message : "Conversas indisponíveis.",
        );
      })
      .finally(() => {
        retryingConversationListRef.current = false;
        setLoadingConversations(false);
      });
  };

  const sendMessage = async () => {
    const bodyText = draft.trim();
    if (!bodyText || !selectedConversation || sending) return;
    const conversationId = selectedConversation.id;
    setSending(true);
    setActionError("");
    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bodyText }),
        },
      );
      const body = (await response.json()) as
        | ConversationMessage
        | { error: string };
      if (!response.ok || "error" in body) {
        throw new Error(
          "error" in body ? collaborationError(body.error) : "Falha ao enviar.",
        );
      }
      if (selectedIdRef.current === conversationId) {
        setMessages((current) => mergeMessages(current, [body]));
      }
      onDraftChange(conversationId, "");
      notify(`Mensagem #${body.sequence} persistida com envelope verificável`);
      void refreshConversations().catch(() => {
        setLoadError(
          "A mensagem foi enviada, mas a lista de conversas não pôde ser atualizada.",
        );
      });
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao enviar.",
      );
    } finally {
      setSending(false);
    }
  };

  const createConversation = async () => {
    if (creating) return;
    const member = workspace?.agents.find(
      (agent) => agent.principal_id === createDraft.memberId,
    );
    const title =
      createDraft.title.trim() ||
      (createDraft.kind === "direct" ? member?.name ?? "" : "");
    if (!title || !createDraft.memberId) {
      setActionError("Defina um título e ao menos um participante.");
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setActionError("");
    try {
      const payload: Record<string, unknown> = {
        kind: createDraft.kind,
        title,
        memberIds: [createDraft.memberId],
      };
      if (createDraft.projectId) payload.projectId = createDraft.projectId;
      if (createDraft.teamId) payload.teamId = createDraft.teamId;
      if (createDraft.workItemId) payload.workItemId = createDraft.workItemId;
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as
        | ConversationSummary
        | { error: string };
      if (!response.ok || "error" in body) {
        throw new Error(
          "error" in body
            ? collaborationError(body.error)
            : "Falha ao criar conversa.",
        );
      }
      conversationModeRef.current = body.kind;
      setConversationMode(body.kind);
      setConversations((current) => [
        body,
        ...current.filter((conversation) => conversation.id !== body.id),
      ]);
      selectConversation(body.id);
      setCreateOpen(false);
      setCreateDraft(emptyConversationDraft());
      window.dispatchEvent(new Event("nexus-conversations-changed"));
      notify(`${MODE_LABELS[body.kind]} criado e persistido`);
      void refreshConversations().catch(() => {
        setLoadError(
          "A conversa foi criada, mas a lista não pôde ser atualizada.",
        );
      });
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao criar conversa.",
      );
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const activeProjects =
    workspace?.projects.filter((project) => project.status !== "archived") ?? [];
  const eligibleTeams =
    workspace?.teams.filter(
      (team) =>
        team.status !== "archived" &&
        (!createDraft.projectId ||
          team.project_id === createDraft.projectId),
    ) ?? [];
  const eligibleWorkItems =
    workspace?.workItems.filter(
      (workItem) =>
        !createDraft.projectId ||
        workItem.project_id === createDraft.projectId,
    ) ?? [];
  const activeAgents =
    workspace?.agents.filter((agent) => agent.status === "active") ?? [];

  return (
    <div className="view-page messages-page" data-testid="messages-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">COLLABORATION FABRIC · REAL</span>
          <h1>Mensagens</h1>
          <p>
            DMs, salas e handoffs persistentes, separados da autoridade de
            execução.
          </p>
        </div>
        <button
          className="primary-button compact"
          onClick={() => {
            const projectId = activeProjects[0]?.id ?? "";
            setActionError("");
            setCreateDraft({
              ...emptyConversationDraft(),
              projectId,
              memberId: activeAgents[0]?.principal_id ?? "",
            });
            setCreateOpen(true);
          }}
        >
          ＋ Nova conversa
        </button>
      </div>
      {loadError && (
        <p className="collaboration-error" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            disabled={loadingConversations}
            onClick={retryConversationList}
          >
            Tentar novamente
          </button>
        </p>
      )}
      {!createOpen && actionError && (
        <p className="collaboration-error" role="alert">
          <span>{actionError}</span>
        </p>
      )}
      <div className="messenger-shell">
        <aside className="conversation-list">
          <div className="conversation-tabs">
            {(Object.keys(MODE_LABELS) as ConversationMode[]).map((mode) => (
              <button
                key={mode}
                className={conversationMode === mode ? "is-active" : ""}
                aria-pressed={conversationMode === mode}
                onClick={() => chooseMode(mode)}
              >
                {MODE_LABELS[mode]}{" "}
                <b>
                  {
                    conversations.filter(
                      (conversation) => conversation.kind === mode,
                    ).length
                  }
                </b>
              </button>
            ))}
          </div>
          <label className="conversation-search">
            <span>⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar pessoas, agents ou rooms"
              aria-label="Buscar conversas"
            />
          </label>
          {loadingConversations && (
            <p className="conversation-list-state">Carregando conversas…</p>
          )}
          {!loadingConversations && visibleConversations.length === 0 && (
            <p className="conversation-list-state">
              Nenhuma conversa neste filtro.
            </p>
          )}
          {visibleConversations.map((conversation) => (
            <button
              key={conversation.id}
              className={selectedId === conversation.id ? "is-selected" : ""}
              aria-current={
                selectedId === conversation.id ? "true" : undefined
              }
              onClick={() => selectConversation(conversation.id)}
            >
              <ConversationAvatar conversation={conversation} />
              <span>
                <b>{conversation.title}</b>
                <small>
                  {MODE_LABELS[conversation.kind]} ·{" "}
                  {conversation.members.filter((member) => member.status === "active").length}{" "}
                  membros
                </small>
                <em>
                  {conversation.latestMessage?.erased
                    ? "Conteúdo removido sob política"
                    : conversation.latestMessage?.bodyText ??
                      "Conversa pronta para começar"}
                </em>
              </span>
              <span className="conversation-meta">
                <small>
                  {conversation.latestMessage
                    ? relativeTime(conversation.latestMessage.createdAt)
                    : ""}
                </small>
                <span
                  className={`conversation-status status-${conversation.status}`}
                  role="img"
                  aria-label={`Status: ${conversation.status}`}
                />
              </span>
            </button>
          ))}
        </aside>
        <section className="message-thread">
          {selectedConversation ? (
            <>
              <header>
                <ConversationAvatar conversation={selectedConversation} large />
                <div>
                  <h2>{selectedConversation.title}</h2>
                  <p>
                    <span
                      className={`status-dot status-${selectedConversation.status === "active" ? "ready" : "waiting"}`}
                    />{" "}
                    {MODE_LABELS[selectedConversation.kind]} ·{" "}
                    {selectedConversation.status}
                  </p>
                </div>
                <button onClick={onProject}>Abrir contexto ↗</button>
              </header>
              <div className="thread-context">
                <span>⌁ Contexto persistido</span>
                <b>{conversationContext(selectedConversation, workspace)}</b>
                <button onClick={onProject}>ver Work Graph</button>
              </div>
              <div
                className="thread-body"
                ref={threadBodyRef}
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                onScroll={(event) => {
                  const body = event.currentTarget;
                  autoScrollRef.current =
                    body.scrollHeight - body.scrollTop - body.clientHeight < 80;
                }}
              >
                <div className="thread-marker">
                  <span>
                    {loadingMessages ? 0 : messages.length} mensagens ·
                    sequência{" "}
                    {loadingMessages
                      ? 0
                      : messages[messages.length - 1]?.sequence ?? 0}
                  </span>
                </div>
                {pollError && (
                  <div className="thread-load-error" role="alert">
                    <span>{pollError}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setPollError("");
                        setRetryToken((current) => current + 1);
                      }}
                    >
                      Tentar novamente
                    </button>
                  </div>
                )}
                {loadingMessages && !pollError && (
                  <p className="thread-empty">Carregando histórico…</p>
                )}
                {!loadingMessages && messages.length === 0 && (
                  <p className="thread-empty">
                    Comece a conversa. Texto não concede autoridade a nenhum
                    agente.
                  </p>
                )}
                {!loadingMessages && messages.map((message) => (
                  <article
                    className={`message-bubble ${
                      message.senderKind === "human"
                        ? "human-message"
                        : "agent-message"
                    }`}
                    key={message.id}
                    data-sequence={message.sequence}
                  >
                    <MessageAvatar message={message} />
                    <div>
                      <header>
                        <b>{message.senderName}</b>
                        <span>{principalLabel(message.senderKind)}</span>
                        <time>{messageTime(message.createdAt)}</time>
                      </header>
                      <p>
                        {message.erased
                          ? "Conteúdo removido sob política de retenção."
                          : message.bodyText}
                      </p>
                      <footer>
                        <span>
                          #{message.sequence} · HMAC{" "}
                          {message.contentHash.slice(0, 10)}…
                        </span>
                      </footer>
                    </div>
                  </article>
                ))}
              </div>
              <form
                className="message-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage();
                }}
              >
                <div className="composer-mode">
                  <span>CONVERSA</span>
                  <em>
                    Nenhuma ação será executada sem um intent explícito
                  </em>
                </div>
                <textarea
                  data-testid="message-composer"
                  value={draft}
                  disabled={
                    sending ||
                    loadingMessages ||
                    selectedConversation.status !== "active"
                  }
                  onChange={(event) =>
                    onDraftChange(selectedConversation.id, event.target.value)
                  }
                  placeholder={
                    selectedConversation.status === "active"
                      ? `Mensagem para ${selectedConversation.title}…`
                      : "Conversa arquivada · somente leitura"
                  }
                  aria-label={`Mensagem para ${selectedConversation.title}`}
                />
                <footer>
                  <div>
                    <button type="button" onClick={onOutput}>
                      Ver artifacts ↗
                    </button>
                    <button
                      type="button"
                      onClick={() => notify("Skills entram no Sprint 10")}
                    >
                      / Skill
                    </button>
                    <button type="button" onClick={onProject}>
                      Ver contexto ↗
                    </button>
                  </div>
                  <button
                    className="primary-button compact"
                    data-testid="send-message"
                    type="submit"
                    disabled={
                      sending ||
                      loadingMessages ||
                      !draft.trim() ||
                      selectedConversation.status !== "active"
                    }
                  >
                    {sending ? "Enviando…" : "Enviar ↗"}
                  </button>
                </footer>
              </form>
            </>
          ) : (
            <div className="conversation-empty-state">
              <span>◌</span>
              <h2>Selecione ou crie uma conversa</h2>
              <p>O histórico será lido diretamente do armazenamento local.</p>
            </div>
          )}
        </section>
        <aside className="conversation-context">
          <span className="eyebrow">SESSION CONTEXT · REAL</span>
          {selectedConversation ? (
            <>
              <div className="context-identity">
                <ConversationAvatar conversation={selectedConversation} large />
                <span>
                  <b>{selectedConversation.title}</b>
                  <small>
                    {MODE_LABELS[selectedConversation.kind]} ·{" "}
                    {selectedConversation.currentRole}
                  </small>
                </span>
              </div>
              <dl>
                <div>
                  <dt>Project</dt>
                  <dd>
                    {projectLabel(workspace, selectedConversation.projectId)}
                  </dd>
                </div>
                <div>
                  <dt>Team</dt>
                  <dd>{teamLabel(workspace, selectedConversation.teamId)}</dd>
                </div>
                <div>
                  <dt>Work item</dt>
                  <dd>
                    {workItemLabel(workspace, selectedConversation.workItemId)}
                  </dd>
                </div>
                <div>
                  <dt>Members</dt>
                  <dd>
                    {selectedConversation.members
                      .filter((member) => member.status === "active")
                      .map((member) => member.displayName)
                      .join(", ")}
                  </dd>
                </div>
              </dl>
              <div className="context-note">
                <b>Boundaries</b>
                <p>
                  Mensagens são inertes. Tool calls exigem ActionIntent,
                  policy check, aprovação aplicável e evidence.
                </p>
              </div>
              <button className="outline-button" onClick={onOutput}>
                Ver outputs relacionados
              </button>
            </>
          ) : (
            <p className="conversation-list-state">Sem contexto selecionado.</p>
          )}
        </aside>
      </div>

      {createOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (creatingRef.current) return;
            setCreateOpen(false);
            setActionError("");
          }}
        >
          <form
            ref={createDialogRef}
            className="entity-editor compact-editor"
            role="dialog"
            aria-modal="true"
            aria-label="Criar conversa"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void createConversation();
            }}
          >
            <header>
              <div>
                <span className="eyebrow">COLLABORATION FABRIC</span>
                <h2>Nova conversa</h2>
                <p>Crie um DM, uma sala de time ou um handoff contextual.</p>
              </div>
              <button
                type="button"
                disabled={creating}
                onClick={() => {
                  setCreateOpen(false);
                  setActionError("");
                }}
              >
                ×
              </button>
            </header>
            {actionError && (
              <p className="collaboration-error" role="alert">
                {actionError}
              </p>
            )}
            <div className="editor-grid">
              <label>
                Formato
                <select
                  value={createDraft.kind}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      kind: event.target.value as ConversationMode,
                      teamId: "",
                      workItemId: "",
                    }))
                  }
                >
                  <option value="direct">Direct message</option>
                  <option value="room">Team room</option>
                  <option value="handoff">Handoff</option>
                </select>
              </label>
              <label>
                Participante
                <select
                  value={createDraft.memberId}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      memberId: event.target.value,
                    }))
                  }
                  required
                >
                  <option value="">Selecione</option>
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={agent.principal_id}>
                      {agent.name} · {agent.role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Projeto
                <select
                  value={createDraft.projectId}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      projectId: event.target.value,
                      teamId: "",
                      workItemId: "",
                    }))
                  }
                >
                  <option value="">Sem vínculo</option>
                  {activeProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Título
                <input
                  value={createDraft.title}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder={
                    createDraft.kind === "direct"
                      ? "Opcional: usa o nome do participante"
                      : "Ex.: Checkout · Sala operacional"
                  }
                />
              </label>
              {createDraft.kind !== "direct" && (
                <label>
                  Time
                  <select
                    value={createDraft.teamId}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        teamId: event.target.value,
                      }))
                    }
                  >
                    <option value="">Sem vínculo</option>
                    {eligibleTeams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {createDraft.kind === "handoff" && (
                <label>
                  Work item
                  <select
                    value={createDraft.workItemId}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        workItemId: event.target.value,
                      }))
                    }
                  >
                    <option value="">Sem vínculo</option>
                    {eligibleWorkItems.map((workItem) => (
                      <option key={workItem.id} value={workItem.id}>
                        {workItem.ref} · {workItem.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="context-note">
              <b>Canal inerte</b>
              <p>
                Criar ou enviar mensagens não aprova nem executa ações. Isso
                permanece exclusivo do fluxo de intents.
              </p>
            </div>
            <footer>
              <button
                className="outline-button"
                type="button"
                disabled={creating}
                onClick={() => {
                  setCreateOpen(false);
                  setActionError("");
                }}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={creating}
              >
                {creating ? "Criando…" : "Criar conversa"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

function ConversationAvatar({
  conversation,
  large = false,
}: {
  conversation: ConversationSummary;
  large?: boolean;
}) {
  const label =
    conversation.kind === "room"
      ? "#"
      : conversation.kind === "handoff"
        ? "↗"
        : initials(conversation.title);
  return (
    <span
      className={`avatar ${large ? "" : "avatar-small"} conversation-avatar-${conversation.kind}`}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

function MessageAvatar({ message }: { message: ConversationMessage }) {
  return (
    <span
      className={`avatar avatar-small ${
        message.senderKind === "human"
          ? "message-avatar-human"
          : "message-avatar-agent"
      }`}
      aria-hidden="true"
    >
      {initials(message.senderName)}
    </span>
  );
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("pt-BR"))
    .join("");
}

export function mergeMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  if (incoming.length === 0) return current;
  const messagesById = new Map(
    [...current, ...incoming].map((message) => [message.id, message]),
  );
  const merged = Array.from(messagesById.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (
    merged.length === current.length &&
    merged.every(
      (message, index) =>
        message.id === current[index]?.id &&
        message.contentHash === current[index]?.contentHash &&
        message.bodyText === current[index]?.bodyText &&
        message.erased === current[index]?.erased,
    )
  ) {
    return current;
  }
  return merged;
}

export function conversationIdForMode(
  conversations: Array<Pick<ConversationSummary, "id" | "kind">>,
  mode: ConversationMode,
  currentId = "",
): string {
  const current = conversations.find(
    (conversation) =>
      conversation.id === currentId && conversation.kind === mode,
  );
  return (
    current?.id ??
    conversations.find((conversation) => conversation.kind === mode)?.id ??
    ""
  );
}

function principalLabel(kind: ConversationMessage["senderKind"]): string {
  const labels: Record<ConversationMessage["senderKind"], string> = {
    human: "Humano",
    agent: "Agent",
    automation: "Automation",
    policy: "Policy",
    runner: "Runner",
  };
  return labels[kind];
}

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function projectLabel(
  workspace: WorkspaceForMessages | null,
  projectId: string | null,
): string {
  if (!projectId) return "Sem vínculo";
  return (
    workspace?.projects.find((project) => project.id === projectId)?.name ??
    "Projeto indisponível"
  );
}

function teamLabel(
  workspace: WorkspaceForMessages | null,
  teamId: string | null,
): string {
  if (!teamId) return "Sem vínculo";
  return (
    workspace?.teams.find((team) => team.id === teamId)?.name ??
    "Time indisponível"
  );
}

function workItemLabel(
  workspace: WorkspaceForMessages | null,
  workItemId: string | null,
): string {
  if (!workItemId) return "Sem vínculo";
  const workItem = workspace?.workItems.find(
    (candidate) => candidate.id === workItemId,
  );
  return workItem
    ? `${workItem.ref} · ${workItem.title}`
    : "Work item indisponível";
}

function conversationContext(
  conversation: ConversationSummary,
  workspace: WorkspaceForMessages | null,
): string {
  return [
    conversation.projectId
      ? projectLabel(workspace, conversation.projectId)
      : null,
    conversation.teamId ? teamLabel(workspace, conversation.teamId) : null,
    conversation.workItemId
      ? workItemLabel(workspace, conversation.workItemId)
      : null,
    conversation.intentId ? "Intent vinculado" : null,
  ]
    .filter(Boolean)
    .join(" / ") || "Conversa sem vínculo operacional";
}

function emptyConversationDraft() {
  return {
    kind: "direct" as ConversationMode,
    title: "",
    memberId: "",
    projectId: "",
    teamId: "",
    workItemId: "",
  };
}

function collaborationError(code: string): string {
  const messages: Record<string, string> = {
    conversation_not_found: "Conversa não encontrada ou sem acesso.",
    conversation_read_only: "Esta conversa está em modo somente leitura.",
    duplicate_conversation: "Esse direct message já existe.",
    direct_requires_two_members: "Um direct message exige duas pessoas.",
    conversation_requires_members: "Inclua pelo menos um participante.",
    invalid_reference: "O contexto selecionado não pertence ao mesmo projeto.",
    message_kind_not_allowed: "O cliente só pode enviar mensagens de texto.",
    invalid_afterSequence: "Cursor de mensagens inválido.",
    workspace_membership_required: "Acesso ao workspace é obrigatório.",
    message_integrity_key_unavailable:
      "A chave de integridade de mensagens não está configurada.",
  };
  return messages[code] ?? "Não foi possível concluir a operação.";
}
