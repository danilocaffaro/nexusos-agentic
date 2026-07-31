"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ConversationMember,
  ConversationMessage,
  ConversationPin,
  ConversationSummary,
  MessageAttachment,
} from "@/src/contracts/collaboration";
import { usePresence } from "./presence-client";
import { useRealtime } from "./realtime-client";
import { pollingDelayMs } from "./realtime-policy";

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
type ContextSection = "context" | "members" | "pins";

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
  initialConversationId,
  onInitialConversationConsumed,
}: {
  onProject: () => void;
  onOutput: () => void;
  notify: (message: string) => void;
  workspace: WorkspaceForMessages | null;
  drafts: Record<string, string>;
  onDraftChange: (conversationId: string, value: string) => void;
  initialConversationId?: string;
  onInitialConversationConsumed?: () => void;
}) {
  const presence = usePresence();
  const {
    status: realtimeStatus,
    subscribe: subscribeRealtime,
  } = useRealtime();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [conversationMode, setConversationMode] =
    useState<ConversationMode>("direct");
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [stagedAttachments, setStagedAttachments] = useState<
    MessageAttachment[]
  >([]);
  const [loadError, setLoadError] = useState("");
  const [pollError, setPollError] = useState("");
  const [actionError, setActionError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [contextSection, setContextSection] =
    useState<ContextSection>("context");
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [compactContext, setCompactContext] = useState(false);
  const [pins, setPins] = useState<ConversationPin[]>([]);
  const [pinsLoadedConversationId, setPinsLoadedConversationId] = useState("");
  const [pinsError, setPinsError] = useState("");
  const [workingAction, setWorkingAction] = useState("");
  const [memberToAdd, setMemberToAdd] = useState("");
  const [memberRole, setMemberRole] =
    useState<Extract<ConversationMember["role"], "member" | "observer">>(
      "member",
    );
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
  const contextAsideRef = useRef<HTMLElement | null>(null);
  const initialConversationIdRef = useRef(initialConversationId ?? "");
  const onInitialConversationConsumedRef = useRef(
    onInitialConversationConsumed,
  );
  const conversationRefreshRunningRef = useRef(false);
  const conversationRefreshPendingRef = useRef(false);
  const realtimeStatusRef = useRef(realtimeStatus);

  useEffect(() => {
    realtimeStatusRef.current = realtimeStatus;
  }, [realtimeStatus]);

  const refreshConversations = useCallback(async () => {
    const body = await requestJson<{ conversations: ConversationSummary[] }>(
      "/api/conversations",
      {
      cache: "no-store",
      },
    );
    setConversations(body.conversations);
    setConversationsLoaded(true);
    setLoadError("");
    return body.conversations;
  }, []);

  const refreshPins = useCallback(async (conversationId: string) => {
    const body = await requestJson<{ pins: ConversationPin[] }>(
      `/api/conversations/${conversationId}/pins`,
      { cache: "no-store" },
    );
    if (selectedIdRef.current === conversationId) {
      setPins(body.pins);
      setPinsLoadedConversationId(conversationId);
      setPinsError("");
    }
    return body.pins;
  }, []);

  const requestConversationRefresh = useCallback(async () => {
    if (conversationRefreshRunningRef.current) {
      conversationRefreshPendingRef.current = true;
      return;
    }
    conversationRefreshRunningRef.current = true;
    try {
      let firstError: unknown;
      let rerun = true;
      while (rerun) {
        conversationRefreshPendingRef.current = false;
        try {
          await refreshConversations();
        } catch (error) {
          firstError ??= error;
        }
        rerun = conversationRefreshPendingRef.current;
      }
      if (firstError) throw firstError;
    } finally {
      conversationRefreshRunningRef.current = false;
    }
  }, [refreshConversations]);

  const selectConversation = useCallback((conversationId: string) => {
    if (selectedIdRef.current === conversationId) return;
    selectedIdRef.current = conversationId;
    loadedConversationIdRef.current = "";
    sequenceRef.current = 0;
    autoScrollRef.current = true;
    setSelectedId(conversationId);
    setLoadedConversationId("");
    setMessages([]);
    setPins([]);
    setPinsLoadedConversationId("");
    setPinsError("");
    setMemberToAdd("");
    setContextDrawerOpen(false);
    setPollError("");
    setActionError("");
    setSelectedFiles([]);
    setStagedAttachments([]);
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void refreshConversations()
        .then((loadedConversations) => {
          if (!active) return;
          setLoadError("");
          const focusedConversation = initialConversationIdRef.current
            ? loadedConversations.find(
                (conversation) =>
                  conversation.id === initialConversationIdRef.current,
              )
            : undefined;
          if (focusedConversation) {
            conversationModeRef.current = focusedConversation.kind;
            setConversationMode(focusedConversation.kind);
            selectConversation(focusedConversation.id);
            initialConversationIdRef.current = "";
            onInitialConversationConsumedRef.current?.();
            return;
          }
          if (initialConversationIdRef.current) {
            initialConversationIdRef.current = "";
            onInitialConversationConsumedRef.current?.();
          }
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
    let active = true;
    let timer: number | undefined;
    const refreshList = () => {
      if (!active || document.hidden) return;
      void requestConversationRefresh().catch(() => undefined);
    };
    const schedule = () => {
      if (!active) return;
      timer = window.setTimeout(() => {
        refreshList();
        schedule();
      }, 60_000);
    };
    const refreshNow = () => {
      window.clearTimeout(timer);
      refreshList();
      schedule();
    };
    const unsubscribe = subscribeRealtime((event) => {
      if (event.kind === "conversation" || event.kind === "resync") {
        refreshNow();
      }
    });
    const handleVisibility = () => {
      if (!document.hidden) refreshNow();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    schedule();
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [requestConversationRefresh, subscribeRealtime]);

  useEffect(() => {
    if (!selectedId) {
      sequenceRef.current = 0;
      loadedConversationIdRef.current = "";
      return;
    }
    let active = true;
    let pulling = false;
    let pendingDirty = false;
    let consecutiveFailures = 0;
    let timer: number | undefined;

    const scheduleNextPull = () => {
      if (!active) return;
      const delay = pollingDelayMs({
        status: realtimeStatusRef.current,
        baseDelayMs: 4_000,
        failureCount: Math.max(0, consecutiveFailures - 1),
        maximumDelayMs: 60_000,
      });
      timer = window.setTimeout(() => void pull(), delay);
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
        const replace = loadedConversationIdRef.current !== selectedId;
        const afterSequence = replace ? 0 : sequenceRef.current;
        const body = await requestJson<{
          messages: ConversationMessage[];
          nextSequence: number;
        }>(
          `/api/conversations/${selectedId}/messages?afterSequence=${afterSequence}`,
          { cache: "no-store" },
        );
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
        if (pendingDirty && active && !document.hidden) {
          pendingDirty = false;
          void pull();
        } else if (!document.hidden) {
          scheduleNextPull();
        }
      }
    };

    const requestPull = () => {
      pendingDirty = true;
      if (pulling || document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void pull();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) requestPull();
    };

    const unsubscribe = subscribeRealtime((event) => {
      if (event.kind === "resync") {
        void refreshPins(selectedId).catch(() => undefined);
        requestPull();
        return;
      }
      if (event.kind !== "conversation") return;
      if (event.conversationId !== selectedId) return;
      void refreshPins(selectedId).catch(() => undefined);
      requestPull();
    });
    void pull();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    subscribeRealtime,
    refreshPins,
    retryToken,
    selectedId,
  ]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void refreshPins(selectedId).catch((reason: unknown) => {
      if (!active || selectedIdRef.current !== selectedId) return;
      setPinsLoadedConversationId(selectedId);
      setPinsError(
        reason instanceof Error ? reason.message : "Pins indisponíveis.",
      );
    });
    return () => {
      active = false;
    };
  }, [refreshPins, selectedId]);

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

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1180px)");
    const update = () => setCompactContext(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (
      !contextDrawerOpen ||
      !compactContext
    ) {
      return;
    }
    const drawer = contextAsideRef.current;
    if (!drawer) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusableSelector =
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    drawer.querySelector<HTMLElement>(focusableSelector)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (!drawer.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
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
  }, [compactContext, contextDrawerOpen]);

  const selectedConversation =
    conversations.find((conversation) => conversation.id === selectedId) ??
    null;
  const { enterRoom, leaveRoom } = presence;
  const presenceRoomTarget = conversationPresenceTarget({
    loading: loadingConversations,
    loaded: conversationsLoaded,
    conversation: selectedConversation,
  });

  useEffect(() => {
    if (presenceRoomTarget === undefined) return;
    if (presenceRoomTarget !== null) {
      enterRoom(presenceRoomTarget);
      return;
    }
    leaveRoom();
  }, [enterRoom, leaveRoom, presenceRoomTarget]);
  const activePinByMessageId = useMemo(
    () => new Map(pins.map((pin) => [pin.messageId, pin])),
    [pins],
  );
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

  const refreshAfterConflict = async (
    reason: unknown,
    includePins = false,
  ) => {
    if (
      !(reason instanceof CollaborationRequestError) ||
      reason.status !== 409
    ) {
      return;
    }
    const conversationId = selectedIdRef.current;
    const conversationResult = await Promise.allSettled([
      refreshConversations(),
      ...(includePins && conversationId
        ? [refreshPins(conversationId)]
        : []),
    ]);
    if (conversationResult[0]?.status === "rejected") {
      setLoadError(
        "Os dados mudaram e a lista não pôde ser atualizada automaticamente.",
      );
    }
    if (conversationResult[1]?.status === "rejected") {
      setPinsError(
        "Os pins mudaram e não puderam ser atualizados automaticamente.",
      );
    }
  };

  const applyMemberToConversation = (
    conversationId: string,
    member: ConversationMember,
  ) => {
    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        const memberExists = conversation.members.some(
          (candidate) => candidate.principalId === member.principalId,
        );
        return {
          ...conversation,
          members: memberExists
            ? conversation.members.map((candidate) =>
                candidate.principalId === member.principalId
                  ? member
                  : candidate,
              )
            : [...conversation.members, member],
        };
      }),
    );
  };

  const sendMessage = async () => {
    const bodyText = draft.trim();
    if (
      !bodyText ||
      !selectedConversation ||
      selectedConversation.currentRole === "observer" ||
      sending
    ) {
      return;
    }
    const conversationId = selectedConversation.id;
    setSending(true);
    setActionError("");
    try {
      let attachments = stagedAttachments;
      if (selectedFiles.length > 0 && attachments.length === 0) {
        const uploaded: MessageAttachment[] = [];
        for (const file of selectedFiles) {
          uploaded.push(
            await requestJson<MessageAttachment>(
              `/api/conversations/${conversationId}/files`,
              {
                method: "POST",
                headers: {
                  "content-type": file.type || "application/octet-stream",
                  "x-nexus-file-name": encodeURIComponent(file.name),
                },
                body: file,
              },
            ),
          );
        }
        attachments = uploaded;
        setStagedAttachments(uploaded);
      }
      const body = await requestJson<ConversationMessage>(
        `/api/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bodyText,
            ...(attachments.length > 0
              ? { attachmentIds: attachments.map((item) => item.id) }
              : {}),
          }),
        },
      );
      if (selectedIdRef.current === conversationId) {
        setMessages((current) => mergeMessages(current, [body]));
      }
      onDraftChange(conversationId, "");
      setSelectedFiles([]);
      setStagedAttachments([]);
      notify(`Mensagem #${body.sequence} persistida com envelope verificável`);
      void refreshConversations().catch(() => {
        setLoadError(
          "A mensagem foi enviada, mas a lista de conversas não pôde ser atualizada.",
        );
      });
    } catch (reason) {
      await refreshAfterConflict(reason);
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao enviar.",
      );
    } finally {
      setSending(false);
    }
  };

  const changeConversationStatus = async (
    nextStatus: ConversationSummary["status"],
  ) => {
    if (!selectedConversation || workingAction) return;
    const conversationId = selectedConversation.id;
    const endpoint = nextStatus === "archived" ? "archive" : "reopen";
    setWorkingAction(endpoint);
    setActionError("");
    try {
      const updated = await requestJson<ConversationSummary>(
        `/api/conversations/${conversationId}/${endpoint}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: selectedConversation.version,
          }),
        },
      );
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === updated.id ? updated : conversation,
        ),
      );
      notify(
        nextStatus === "archived"
          ? "Conversa arquivada sem apagar o histórico"
          : "Conversa reaberta para colaboração",
      );
      window.dispatchEvent(new Event("nexus-conversations-changed"));
    } catch (reason) {
      await refreshAfterConflict(reason);
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Falha ao alterar a conversa.",
      );
    } finally {
      setWorkingAction("");
    }
  };

  const addMember = async () => {
    if (!selectedConversation || !memberToAdd || workingAction) return;
    setWorkingAction("add-member");
    setActionError("");
    try {
      const added = await requestJson<ConversationMember>(
        `/api/conversations/${selectedConversation.id}/members`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            principalId: memberToAdd,
            role: memberRole,
          }),
        },
      );
      applyMemberToConversation(selectedConversation.id, added);
      setMemberToAdd("");
      notify(`${added.displayName} entrou como ${roleLabel(added.role)}`);
      void refreshConversations().catch(() =>
        setLoadError(
          "O membro foi adicionado, mas a lista não pôde ser sincronizada.",
        ),
      );
    } catch (reason) {
      await refreshAfterConflict(reason);
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao adicionar membro.",
      );
    } finally {
      setWorkingAction("");
    }
  };

  const updateMemberRole = async (
    member: ConversationMember,
    role: Extract<ConversationMember["role"], "member" | "observer">,
  ) => {
    if (!selectedConversation || workingAction) return;
    setWorkingAction(`member-${member.principalId}`);
    setActionError("");
    try {
      const updated = await requestJson<ConversationMember>(
        `/api/conversations/${selectedConversation.id}/members/${member.principalId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role, expectedVersion: member.version }),
        },
      );
      applyMemberToConversation(selectedConversation.id, updated);
      notify(`${updated.displayName} agora é ${roleLabel(updated.role)}`);
      void refreshConversations().catch(() =>
        setLoadError(
          "O papel foi alterado, mas a lista não pôde ser sincronizada.",
        ),
      );
    } catch (reason) {
      await refreshAfterConflict(reason);
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao alterar o papel.",
      );
    } finally {
      setWorkingAction("");
    }
  };

  const removeMember = async (member: ConversationMember) => {
    if (!selectedConversation || workingAction) return;
    setWorkingAction(`member-${member.principalId}`);
    setActionError("");
    try {
      const removed = await requestJson<ConversationMember>(
        `/api/conversations/${selectedConversation.id}/members/${member.principalId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: member.version }),
        },
      );
      applyMemberToConversation(selectedConversation.id, removed);
      notify(`${removed.displayName} removido; histórico preservado`);
      void refreshConversations().catch(() =>
        setLoadError(
          "O membro foi removido, mas a lista não pôde ser sincronizada.",
        ),
      );
    } catch (reason) {
      await refreshAfterConflict(reason);
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao remover membro.",
      );
    } finally {
      setWorkingAction("");
    }
  };

  const pinMessage = async (message: ConversationMessage) => {
    if (!selectedConversation || workingAction) return;
    const conversationId = selectedConversation.id;
    setWorkingAction(`pin-message-${message.id}`);
    setActionError("");
    try {
      const pin = await requestJson<ConversationPin>(
        `/api/conversations/${conversationId}/pins`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId: message.id }),
        },
      );
      if (selectedIdRef.current === conversationId) {
        setPins((current) =>
          current.some((candidate) => candidate.id === pin.id)
            ? current
            : [...current, pin],
        );
        setContextSection("pins");
        setContextDrawerOpen(true);
      }
      notify(`Mensagem #${message.sequence} fixada no contexto`);
    } catch (reason) {
      await refreshAfterConflict(reason, true);
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao fixar mensagem.",
      );
    } finally {
      setWorkingAction("");
    }
  };

  const unpinMessage = async (pin: ConversationPin) => {
    if (!selectedConversation || workingAction) return;
    const conversationId = selectedConversation.id;
    setWorkingAction(`pin-${pin.id}`);
    setActionError("");
    try {
      await requestJson<ConversationPin>(
        `/api/conversations/${conversationId}/pins/${pin.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: pin.version }),
        },
      );
      if (selectedIdRef.current === conversationId) {
        setPins((current) =>
          current.filter((candidate) => candidate.id !== pin.id),
        );
      }
      notify(`Pin da mensagem #${pin.message.sequence} removido`);
    } catch (reason) {
      await refreshAfterConflict(reason, true);
      setActionError(
        reason instanceof Error ? reason.message : "Falha ao remover pin.",
      );
    } finally {
      setWorkingAction("");
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
      const body = await requestJson<ConversationSummary>(
        "/api/conversations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
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
  const addableAgents = selectedConversation
    ? activeAgents.filter(
        (agent) =>
          !selectedConversation.members.some(
            (member) =>
              member.principalId === agent.principal_id &&
              member.status === "active",
          ),
      )
    : [];

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
            setContextDrawerOpen(false);
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
                  aria-label={`Status: ${conversationStatusLabel(
                    conversation.status,
                  )}`}
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
                    {conversationStatusLabel(selectedConversation.status)}
                  </p>
                </div>
                <div className="thread-actions">
                  <button onClick={onProject}>Abrir contexto ↗</button>
                  <button
                    type="button"
                    onClick={() => {
                      setContextSection("members");
                      setContextDrawerOpen(true);
                    }}
                  >
                    Membros
                  </button>
                  {selectedConversation.currentRole === "owner" && (
                    <button
                      type="button"
                      className={
                        selectedConversation.status === "active"
                          ? "archive-conversation"
                          : ""
                      }
                      disabled={Boolean(workingAction)}
                      onClick={() =>
                        void changeConversationStatus(
                          selectedConversation.status === "active"
                            ? "archived"
                            : "active",
                        )
                      }
                    >
                      {workingAction === "archive" ||
                      workingAction === "reopen"
                        ? "Salvando…"
                        : selectedConversation.status === "active"
                          ? "Arquivar"
                          : "Reabrir"}
                    </button>
                  )}
                </div>
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
                      {(message.attachments ?? []).length > 0 && (
                        <div className="message-attachments">
                          {(message.attachments ?? []).map((attachment) => (
                            <a
                              key={attachment.id}
                              href={attachment.downloadUrl}
                              download
                            >
                              <span aria-hidden="true">⇩</span>
                              <span>
                                <b>{attachment.originalName}</b>
                                <small>
                                  {formatFileSize(attachment.byteSize)} ·{" "}
                                  {attachment.scanStatus === "clean"
                                    ? "verificado"
                                    : "download protegido"}
                                </small>
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
                      <footer>
                        <button
                          type="button"
                          disabled={
                            Boolean(activePinByMessageId.get(message.id)) ||
                            Boolean(workingAction) ||
                            message.erased ||
                            selectedConversation.status !== "active" ||
                            selectedConversation.currentRole === "observer"
                          }
                          aria-label={
                            activePinByMessageId.has(message.id)
                              ? `Mensagem ${message.sequence} fixada`
                              : `Fixar mensagem ${message.sequence}`
                          }
                          onClick={() => void pinMessage(message)}
                        >
                          {workingAction === `pin-message-${message.id}`
                            ? "Fixando…"
                            : activePinByMessageId.has(message.id)
                              ? "◆ Fixado"
                              : "◇ Fixar"}
                        </button>
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
                    selectedConversation.currentRole === "observer" ||
                    selectedConversation.status !== "active"
                  }
                  onChange={(event) =>
                    onDraftChange(selectedConversation.id, event.target.value)
                  }
                  placeholder={
                    selectedConversation.status !== "active"
                      ? "Conversa arquivada · somente leitura"
                      : selectedConversation.currentRole === "observer"
                        ? "Observadores acompanham esta conversa em modo somente leitura"
                        : `Mensagem para ${selectedConversation.title}…`
                  }
                  aria-label={`Mensagem para ${selectedConversation.title}`}
                />
                {selectedFiles.length > 0 && (
                  <div
                    className="composer-files"
                    aria-label="Arquivos selecionados"
                  >
                    {selectedFiles.map((file) => (
                      <span key={`${file.name}:${file.size}`}>
                        <b>{file.name}</b>
                        <small>{formatFileSize(file.size)}</small>
                        <button
                          type="button"
                          aria-label={`Remover ${file.name}`}
                          disabled={sending}
                          onClick={() => {
                            setSelectedFiles((current) =>
                              current.filter(
                                (candidate) => candidate !== file,
                              ),
                            );
                            setStagedAttachments([]);
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <footer>
                  <div>
                    <label className="composer-file-button">
                      Anexar arquivo
                      <input
                        type="file"
                        multiple
                        disabled={sending || selectedFiles.length >= 3}
                        accept=".txt,.md,.csv,.json,.pdf,.png,.jpg,.jpeg,.gif,.webp,.zip,.docx,.xlsx,.pptx"
                        onChange={(event) => {
                          const files = Array.from(
                            event.target.files ?? [],
                          );
                          if (
                            files.length > 3 ||
                            files.some(
                              (file) =>
                                file.size > 25 * 1024 * 1024 ||
                                file.size < 1,
                            )
                          ) {
                            setActionError(
                              "Selecione até 3 arquivos de no máximo 25 MB cada.",
                            );
                            event.target.value = "";
                            return;
                          }
                          setActionError("");
                          setSelectedFiles(files);
                          setStagedAttachments([]);
                        }}
                      />
                    </label>
                    <button type="button" onClick={onOutput}>
                      Ver artifacts ↗
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
                      selectedConversation.currentRole === "observer" ||
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
        {contextDrawerOpen && (
          <button
            className="context-drawer-backdrop"
            type="button"
            aria-label="Fechar painel de detalhes"
            onClick={() => setContextDrawerOpen(false)}
          />
        )}
        <aside
          ref={contextAsideRef}
          className={`conversation-context ${
            contextDrawerOpen ? "is-open" : ""
          }`}
          aria-label="Detalhes da conversa"
          role={contextDrawerOpen && compactContext ? "dialog" : undefined}
          aria-modal={
            contextDrawerOpen && compactContext ? true : undefined
          }
        >
          <button
            className="context-drawer-close"
            type="button"
            aria-label="Fechar detalhes da conversa"
            onClick={() => setContextDrawerOpen(false)}
          >
            ×
          </button>
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
              <div className="context-tabs" aria-label="Detalhes">
                {(
                  [
                    ["context", "Contexto"],
                    ["members", "Membros"],
                    ["pins", `Pins ${pins.length}`],
                  ] as const
                ).map(([section, label]) => (
                  <button
                    key={section}
                    type="button"
                    aria-pressed={contextSection === section}
                    className={contextSection === section ? "is-active" : ""}
                    onClick={() => setContextSection(section)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {contextSection === "context" && (
                <>
                  <dl>
                    <div>
                      <dt>Project</dt>
                      <dd>
                        {projectLabel(workspace, selectedConversation.projectId)}
                      </dd>
                    </div>
                    <div>
                      <dt>Team</dt>
                      <dd>
                        {teamLabel(workspace, selectedConversation.teamId)}
                      </dd>
                    </div>
                    <div>
                      <dt>Work item</dt>
                      <dd>
                        {workItemLabel(
                          workspace,
                          selectedConversation.workItemId,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        {selectedConversation.status === "active"
                          ? "Ativa"
                          : "Arquivada · read-only"}
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
              )}
              {contextSection === "members" && (
                <div className="conversation-members-panel">
                  {selectedConversation.kind === "direct" && (
                    <p className="context-inline-note">
                      Participantes de um DM são imutáveis. Arquive o DM para
                      encerrar sem apagar o histórico.
                    </p>
                  )}
                  <div className="conversation-member-list">
                    {selectedConversation.members
                      .slice()
                      .sort((left, right) =>
                        left.status === right.status
                          ? left.displayName.localeCompare(right.displayName)
                          : left.status === "active"
                            ? -1
                            : 1,
                      )
                      .map((member) => (
                        <div
                          className={`conversation-member-row status-${member.status}`}
                          key={member.principalId}
                        >
                          <span
                            className={`avatar avatar-small ${
                              member.principalKind === "human"
                                ? "message-avatar-human"
                                : "message-avatar-agent"
                            }`}
                            aria-hidden="true"
                          >
                            {initials(member.displayName)}
                          </span>
                          <span>
                            <b>{member.displayName}</b>
                            <small>
                              {principalLabel(member.principalKind)} ·{" "}
                              {member.status === "active"
                                ? roleLabel(member.role)
                                : statusLabel(member.status)}
                            </small>
                          </span>
                          {selectedConversation.currentRole === "owner" &&
                          selectedConversation.kind !== "direct" &&
                          selectedConversation.status === "active" &&
                          member.status === "active" &&
                          member.role !== "owner" ? (
                            <span className="member-controls">
                              <select
                                aria-label={`Papel de ${member.displayName}`}
                                value={member.role}
                                disabled={Boolean(workingAction)}
                                onChange={(event) =>
                                  void updateMemberRole(
                                    member,
                                    event.target.value as
                                      | "member"
                                      | "observer",
                                  )
                                }
                              >
                                <option value="member">Membro</option>
                                <option value="observer">Observador</option>
                              </select>
                              <button
                                type="button"
                                aria-label={`Remover ${member.displayName}`}
                                disabled={Boolean(workingAction)}
                                onClick={() => void removeMember(member)}
                              >
                                {workingAction ===
                                `member-${member.principalId}`
                                  ? "…"
                                  : "×"}
                              </button>
                            </span>
                          ) : (
                            <small className="member-version">
                              v{member.version}
                            </small>
                          )}
                        </div>
                      ))}
                  </div>
                  {selectedConversation.currentRole === "owner" &&
                    selectedConversation.kind !== "direct" &&
                    selectedConversation.status === "active" && (
                      <form
                        className="add-conversation-member"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void addMember();
                        }}
                      >
                        <label>
                          Adicionar agent
                          <select
                            value={memberToAdd}
                            onChange={(event) =>
                              setMemberToAdd(event.target.value)
                            }
                            disabled={Boolean(workingAction)}
                          >
                            <option value="">Selecione</option>
                            {addableAgents.map((agent) => (
                              <option
                                key={agent.id}
                                value={agent.principal_id}
                              >
                                {agent.name} · {agent.role}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Papel
                          <select
                            value={memberRole}
                            onChange={(event) =>
                              setMemberRole(
                                event.target.value as
                                  | "member"
                                  | "observer",
                              )
                            }
                            disabled={Boolean(workingAction)}
                          >
                            <option value="member">Membro</option>
                            <option value="observer">Observador</option>
                          </select>
                        </label>
                        <button
                          className="primary-button compact"
                          type="submit"
                          disabled={!memberToAdd || Boolean(workingAction)}
                        >
                          {workingAction === "add-member"
                            ? "Adicionando…"
                            : "Adicionar"}
                        </button>
                      </form>
                    )}
                </div>
              )}
              {contextSection === "pins" && (
                <div className="conversation-pins-panel">
                  {pinsLoadedConversationId !== selectedConversation.id &&
                    !pinsError && (
                      <p className="context-inline-note">Carregando pins…</p>
                    )}
                  {pinsError && (
                    <p className="context-inline-error" role="alert">
                      <span>{pinsError}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setPinsError("");
                          void refreshPins(selectedConversation.id).catch(
                            (reason: unknown) =>
                              setPinsError(
                                reason instanceof Error
                                  ? reason.message
                                  : "Pins indisponíveis.",
                              ),
                          );
                        }}
                      >
                        Tentar novamente
                      </button>
                    </p>
                  )}
                  {pinsLoadedConversationId === selectedConversation.id &&
                    !pinsError &&
                    pins.length === 0 && (
                      <p className="context-inline-note">
                        Nenhuma mensagem fixada. Use “Fixar” em uma mensagem
                        para preservar o contexto operacional.
                      </p>
                    )}
                  {pins.map((pin) => (
                    <article className="conversation-pin-card" key={pin.id}>
                      <header>
                        <b>Mensagem #{pin.message.sequence}</b>
                        <span>{relativeTime(pin.pinnedAt)}</span>
                      </header>
                      <p>
                        {pin.message.erased
                          ? "Conteúdo removido sob política de retenção."
                          : pin.message.bodyText}
                      </p>
                      <footer>
                        <span>
                          {pin.message.senderName} · fixado por{" "}
                          {pin.pinnedByName}
                        </span>
                        {selectedConversation.currentRole !== "observer" &&
                          (selectedConversation.currentRole === "owner" ||
                            selectedConversation.currentPrincipalId ===
                              pin.pinnedBy) &&
                          selectedConversation.status === "active" && (
                            <button
                              type="button"
                              disabled={Boolean(workingAction)}
                              onClick={() => void unpinMessage(pin)}
                            >
                              {workingAction === `pin-${pin.id}`
                                ? "Removendo…"
                                : "Remover"}
                            </button>
                          )}
                      </footer>
                    </article>
                  ))}
                </div>
              )}
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

export function conversationPresenceTarget(input: {
  loading: boolean;
  loaded: boolean;
  conversation:
    | Pick<ConversationSummary, "id" | "kind" | "status">
    | null;
}): string | null | undefined {
  if (input.loading || !input.loaded) return undefined;
  if (
    input.conversation?.kind === "room" &&
    input.conversation.status === "active"
  ) {
    return input.conversation.id;
  }
  return null;
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

class CollaborationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "CollaborationRequestError";
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, init).catch(() => {
    throw new Error("Conexão indisponível. Verifique a rede e tente novamente.");
  });
  const body = (await response.json().catch(() => null)) as
    | T
    | { error: string }
    | null;
  if (
    !response.ok ||
    body === null ||
    (typeof body === "object" && "error" in body)
  ) {
    const code =
      typeof body === "object" && body !== null && "error" in body
        ? body.error
        : null;
    throw new CollaborationRequestError(
      code
        ? collaborationError(code)
        : "Não foi possível concluir a operação.",
      response.status,
      code,
    );
  }
  return body as T;
}

function roleLabel(role: ConversationMember["role"]): string {
  return {
    owner: "Owner",
    member: "Membro",
    observer: "Observador",
  }[role];
}

function statusLabel(status: ConversationMember["status"]): string {
  return {
    active: "Ativo",
    left: "Saiu",
    removed: "Removido",
  }[status];
}

function conversationStatusLabel(
  status: ConversationSummary["status"],
): string {
  return status === "active" ? "ativa" : "arquivada";
}

export function collaborationError(code: string): string {
  const messages: Record<string, string> = {
    conversation_not_found: "Conversa não encontrada ou sem acesso.",
    conversation_read_only: "Esta conversa está em modo somente leitura.",
    conversation_archived: "Esta conversa está arquivada.",
    invalid_status_transition: "A conversa já mudou de estado. Atualize e tente novamente.",
    conversation_owner_required: "Apenas um owner pode concluir esta operação.",
    conversation_requires_owner:
      "A conversa precisa manter ao menos um owner humano ativo.",
    conversation_member_inactive: "Esse participante não está mais ativo.",
    conversation_member_not_found:
      "O participante não existe mais ou não está acessível.",
    direct_membership_immutable:
      "Participantes de um direct message não podem ser alterados.",
    member_already_active: "Esse participante já está ativo na conversa.",
    member_already_exists: "Esse participante já faz parte do histórico.",
    version_conflict: "Os dados mudaram. Atualize e tente novamente.",
    invalid_expectedVersion: "A versão informada para a alteração é inválida.",
    invalid_role: "O papel selecionado é inválido.",
    pin_already_active: "Essa mensagem já está fixada.",
    pin_limit_reached: "A conversa atingiu o limite de 20 pins ativos.",
    conversation_pin_not_found: "O pin não existe mais ou não está acessível.",
    duplicate_conversation: "Esse direct message já existe.",
    attachment_conversation_membership_required:
      "Você não pode anexar arquivos nesta conversa.",
    attachment_not_found: "O arquivo não existe mais ou não está acessível.",
    file_content_invalid:
      "O conteúdo do arquivo não corresponde ao formato informado.",
    file_name_invalid: "O nome do arquivo não é aceito.",
    file_storage_unavailable:
      "O armazenamento de arquivos está temporariamente indisponível.",
    file_too_large: "O arquivo excede o limite de 25 MB.",
    file_type_not_allowed:
      "Este tipo de arquivo não é permitido nesta versão.",
    invalid_attachment_ids: "A lista de anexos é inválida.",
    staged_attachment_not_available:
      "Um anexo mudou de estado. Remova-o e envie novamente.",
    direct_requires_two_members: "Um direct message exige duas pessoas.",
    conversation_requires_members: "Inclua pelo menos um participante.",
    invalid_reference:
      "A referência selecionada não está ativa ou não pertence a este workspace.",
    message_kind_not_allowed: "O cliente só pode enviar mensagens de texto.",
    invalid_afterSequence: "Cursor de mensagens inválido.",
    workspace_membership_required: "Acesso ao workspace é obrigatório.",
    message_integrity_key_unavailable:
      "A chave de integridade de mensagens não está configurada.",
  };
  return messages[code] ?? "Não foi possível concluir a operação.";
}
