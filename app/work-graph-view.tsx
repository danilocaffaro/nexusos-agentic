"use client";

import { useEffect, useMemo, useState } from "react";

export type WorkGraphObjective = {
  id: string;
  project_id: string;
  ref: string;
  title: string;
  description: string;
  status: "open" | "active" | "completed" | "cancelled";
  priority: "p0" | "p1" | "p2" | "p3";
  version: number;
};

export type WorkGraphItem = {
  id: string;
  project_id: string;
  objective_id: string | null;
  ref: string;
  kind: "task" | "bug" | "spike" | "story";
  title: string;
  description: string;
  status:
    | "backlog"
    | "ready"
    | "in_progress"
    | "blocked"
    | "in_review"
    | "done"
    | "cancelled";
  priority: "p0" | "p1" | "p2" | "p3";
  assignee_id: string | null;
  external_ref: string | null;
  version: number;
};

type Props = {
  projectId: string;
  objectives: WorkGraphObjective[];
  workItems: WorkGraphItem[];
  onChanged: () => void;
  notify: (message: string) => void;
};

const columns: Array<{
  id: string;
  label: string;
  statuses: WorkGraphItem["status"][];
}> = [
  { id: "backlog", label: "BACKLOG", statuses: ["backlog"] },
  { id: "ready", label: "READY", statuses: ["ready"] },
  { id: "progress", label: "IN PROGRESS", statuses: ["in_progress"] },
  { id: "attention", label: "ATTENTION", statuses: ["blocked", "in_review"] },
  { id: "closed", label: "CLOSED", statuses: ["done", "cancelled"] },
];

const nextStatuses: Record<
  WorkGraphItem["status"],
  WorkGraphItem["status"][]
> = {
  backlog: ["ready", "cancelled"],
  ready: ["backlog", "in_progress", "cancelled"],
  in_progress: ["ready", "blocked", "in_review", "done", "cancelled"],
  blocked: ["ready", "in_progress", "cancelled"],
  in_review: ["in_progress", "blocked", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["backlog"],
};

export function ProjectWorkGraph({
  projectId,
  objectives,
  workItems,
  onChanged,
  notify,
}: Props) {
  const [objectiveFilter, setObjectiveFilter] = useState("all");
  const [editor, setEditor] = useState<"objective" | "work" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState("");
  const [objectiveDraft, setObjectiveDraft] = useState({
    title: "",
    description: "",
    priority: "p1" as WorkGraphObjective["priority"],
  });
  const [workDraft, setWorkDraft] = useState({
    objectiveId: "",
    kind: "task" as WorkGraphItem["kind"],
    title: "",
    description: "",
    priority: "p1" as WorkGraphItem["priority"],
  });

  const projectObjectives = useMemo(
    () => objectives.filter((objective) => objective.project_id === projectId),
    [objectives, projectId],
  );
  const projectWorkItems = useMemo(
    () => workItems.filter((item) => item.project_id === projectId),
    [workItems, projectId],
  );
  const visibleWorkItems =
    objectiveFilter === "all"
      ? projectWorkItems
      : projectWorkItems.filter(
          (item) => (item.objective_id ?? "none") === objectiveFilter,
        );
  const editorSaving = pendingKeys.includes("editor");

  useEffect(() => {
    if (!editor) return;
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="work-graph-editor"]',
    );
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    focusable[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editorSaving) {
        setEditor(null);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [editor, editorSaving]);

  const mutate = async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    pendingKey: string,
  ) => {
    setPendingKeys((current) => [...current, pendingKey]);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        id?: string;
      };
      if (!response.ok) {
        setError(workGraphError(payload.error));
        if (response.status === 409) {
          onChanged();
          if (pendingKey === "editor") setConflicted(true);
        }
        return null;
      }
      window.dispatchEvent(new Event("nexus-workspace-changed"));
      onChanged();
      return payload;
    } catch {
      setError("A operação não chegou ao workspace local.");
      return null;
    } finally {
      setPendingKeys((current) =>
        current.filter((candidate) => candidate !== pendingKey),
      );
    }
  };

  const openNewObjective = () => {
    setEditingId(null);
    setEditingVersion(null);
    setConflicted(false);
    setObjectiveDraft({ title: "", description: "", priority: "p1" });
    setError("");
    setEditor("objective");
  };

  const openObjective = (objective: WorkGraphObjective) => {
    setEditingId(objective.id);
    setEditingVersion(objective.version);
    setConflicted(false);
    setObjectiveDraft({
      title: objective.title,
      description: objective.description,
      priority: objective.priority,
    });
    setError("");
    setEditor("objective");
  };

  const saveObjective = async () => {
    const stored = projectObjectives.find(
      (objective) => objective.id === editingId,
    );
    const result =
      stored && editingId && editingVersion
        ? await mutate(`/api/workspace/objectives/${editingId}`, "PATCH", {
            expectedVersion: editingVersion,
            ...objectiveDraft,
          }, "editor")
        : await mutate("/api/workspace/objectives", "POST", {
            projectId,
            ...objectiveDraft,
          }, "editor");
    if (result) {
      setEditor(null);
      if (!editingId && result.id) setObjectiveFilter(result.id);
      notify(editingId ? "Objetivo atualizado" : "Objetivo criado");
    }
  };

  const transitionObjective = async (
    objective: WorkGraphObjective,
    status: WorkGraphObjective["status"],
  ) => {
    const result = await mutate(
      `/api/workspace/objectives/${objective.id}`,
      "PATCH",
      { expectedVersion: objective.version, status },
      `objective:${objective.id}`,
    );
    if (result) notify(`${objective.ref} → ${status}`);
  };

  const openNewWorkItem = () => {
    setEditingId(null);
    setEditingVersion(null);
    setConflicted(false);
    setWorkDraft({
      objectiveId:
        objectiveFilter !== "all" && objectiveFilter !== "none"
          ? objectiveFilter
          : projectObjectives.find((objective) =>
                ["open", "active"].includes(objective.status),
              )?.id ?? "",
      kind: "task",
      title: "",
      description: "",
      priority: "p1",
    });
    setError("");
    setEditor("work");
  };

  const openWorkItem = (item: WorkGraphItem) => {
    setEditingId(item.id);
    setEditingVersion(item.version);
    setConflicted(false);
    setWorkDraft({
      objectiveId: item.objective_id ?? "",
      kind: item.kind,
      title: item.title,
      description: item.description,
      priority: item.priority,
    });
    setError("");
    setEditor("work");
  };

  const saveWorkItem = async () => {
    const stored = projectWorkItems.find((item) => item.id === editingId);
    const commonBody = {
      kind: workDraft.kind,
      title: workDraft.title,
      description: workDraft.description,
      priority: workDraft.priority,
    };
    const result =
      stored && editingId && editingVersion
        ? await mutate(`/api/workspace/work-items/${editingId}`, "PATCH", {
            expectedVersion: editingVersion,
            ...commonBody,
            ...(workDraft.objectiveId !== (stored.objective_id ?? "")
              ? { objectiveId: workDraft.objectiveId || null }
              : {}),
          }, "editor")
        : await mutate("/api/workspace/work-items", "POST", {
            projectId,
            objectiveId: workDraft.objectiveId || null,
            ...commonBody,
          }, "editor");
    if (result) {
      setEditor(null);
      notify(editingId ? "WorkItem atualizado" : "WorkItem criado");
    }
  };

  const transitionWorkItem = async (
    item: WorkGraphItem,
    status: WorkGraphItem["status"],
  ) => {
    const result = await mutate(
      `/api/workspace/work-items/${item.id}`,
      "PATCH",
      { expectedVersion: item.version, status },
      `work:${item.id}`,
    );
    if (result) notify(`${item.ref} → ${statusLabel(status)}`);
  };

  return (
    <section className="real-work-graph" data-testid="real-work-graph">
      <header>
        <div>
          <span className="eyebrow">WORK GRAPH · REAL</span>
          <h2>Objetivos e trabalho em fluxo</h2>
          <p>
            Estado Nexus persistente. GitHub Issues será um adapter governado.
          </p>
        </div>
        <div>
          <button className="outline-button" onClick={openNewObjective}>
            ＋ Objetivo
          </button>
          <button className="primary-button compact" onClick={openNewWorkItem}>
            ＋ WorkItem
          </button>
        </div>
      </header>

      {error && (
        <p className="workspace-form-error" role="alert">
          {error}
        </p>
      )}

      <div className="objective-rail">
        <button
          className={objectiveFilter === "all" ? "is-selected" : ""}
          onClick={() => setObjectiveFilter("all")}
        >
          <small>PORTFÓLIO</small>
          <b>Todo o trabalho</b>
          <span>{projectWorkItems.length} itens</span>
        </button>
        {projectObjectives.map((objective) => {
          const itemCount = projectWorkItems.filter(
            (item) => item.objective_id === objective.id,
          ).length;
          return (
            <button
              key={objective.id}
              className={
                objectiveFilter === objective.id ? "is-selected" : ""
              }
              onClick={() => setObjectiveFilter(objective.id)}
            >
              <small>
                {objective.ref} · {objective.status}
              </small>
              <b>{objective.title}</b>
              <span>{itemCount} itens · {objective.priority.toUpperCase()}</span>
            </button>
          );
        })}
        <button
          className={objectiveFilter === "none" ? "is-selected" : ""}
          onClick={() => setObjectiveFilter("none")}
        >
          <small>UNALIGNED</small>
          <b>Sem objetivo</b>
          <span>
            {projectWorkItems.filter((item) => !item.objective_id).length} itens
          </span>
        </button>
      </div>

      {objectiveFilter !== "all" && objectiveFilter !== "none" && (
        <ObjectiveDetail
          objective={projectObjectives.find(
            (item) => item.id === objectiveFilter,
          )}
          pending={pendingKeys.includes(`objective:${objectiveFilter}`)}
          onEdit={openObjective}
          onTransition={transitionObjective}
        />
      )}

      <div className="real-work-board">
        {columns.map((column) => {
          const items = visibleWorkItems.filter((item) =>
            column.statuses.includes(item.status),
          );
          return (
            <section className="real-work-column" key={column.id}>
              <header>
                <span>{column.label}</span>
                <b>{items.length}</b>
              </header>
              {items.map((item) => (
                <article className="real-work-card" key={item.id}>
                  <div>
                    <code>{item.ref}</code>
                    <span className={`priority priority-${item.priority}`}>
                      {item.priority.toUpperCase()}
                    </span>
                  </div>
                  <small>
                    {item.kind.toUpperCase()} ·{" "}
                    {projectObjectives.find(
                      (objective) => objective.id === item.objective_id,
                    )?.ref ?? "UNALIGNED"}
                  </small>
                  <h3>{item.title}</h3>
                  <footer>
                    <select
                      aria-label={`Mover ${item.ref}`}
                      value={item.status}
                      disabled={pendingKeys.includes(`work:${item.id}`)}
                      onChange={(event) =>
                        void transitionWorkItem(
                          item,
                          event.target.value as WorkGraphItem["status"],
                        )
                      }
                    >
                      <option value={item.status}>
                        {statusLabel(item.status)}
                      </option>
                      {nextStatuses[item.status].map((status) => (
                        <option key={status} value={status}>
                          → {statusLabel(status)}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => openWorkItem(item)}>Editar</button>
                  </footer>
                </article>
              ))}
              {items.length === 0 && <p>Nenhum item</p>}
            </section>
          );
        })}
      </div>

      {editor && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!editorSaving) setEditor(null);
          }}
        >
          <form
            className="entity-editor compact-editor"
            data-testid="work-graph-editor"
            role="dialog"
            aria-modal="true"
            aria-label={
              editor === "objective"
                ? editingId
                  ? "Editar objetivo"
                  : "Novo objetivo"
                : editingId
                  ? "Editar WorkItem"
                  : "Novo WorkItem"
            }
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void (editor === "objective" ? saveObjective() : saveWorkItem());
            }}
          >
            <header>
              <div>
                <span className="eyebrow">
                  {editor === "objective" ? "OBJECTIVE STUDIO" : "WORK STUDIO"}
                </span>
                <h2>
                  {editingId ? "Editar" : "Criar"}{" "}
                  {editor === "objective" ? "objetivo" : "WorkItem"}
                </h2>
                <p>Referência Nexus imutável e versionamento otimista.</p>
              </div>
              <button
                type="button"
                disabled={editorSaving}
                onClick={() => setEditor(null)}
              >
                ×
              </button>
            </header>
            {editor === "objective" ? (
              <>
                <label>
                  Título
                  <input
                    value={objectiveDraft.title}
                    onChange={(event) =>
                      setObjectiveDraft({
                        ...objectiveDraft,
                        title: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Contexto e critério de sucesso
                  <textarea
                    value={objectiveDraft.description}
                    onChange={(event) =>
                      setObjectiveDraft({
                        ...objectiveDraft,
                        description: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Prioridade
                  <PrioritySelect
                    value={objectiveDraft.priority}
                    onChange={(priority) =>
                      setObjectiveDraft({ ...objectiveDraft, priority })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Título
                  <input
                    value={workDraft.title}
                    onChange={(event) =>
                      setWorkDraft({ ...workDraft, title: event.target.value })
                    }
                  />
                </label>
                <label>
                  Descrição
                  <textarea
                    value={workDraft.description}
                    onChange={(event) =>
                      setWorkDraft({
                        ...workDraft,
                        description: event.target.value,
                      })
                    }
                  />
                </label>
                <div className="editor-grid">
                  <label>
                    Objetivo
                    <select
                      value={workDraft.objectiveId}
                      onChange={(event) =>
                        setWorkDraft({
                          ...workDraft,
                          objectiveId: event.target.value,
                        })
                      }
                    >
                      <option value="">Sem objetivo</option>
                      {projectObjectives
                        .filter((objective) =>
                          ["open", "active"].includes(objective.status) ||
                          objective.id === workDraft.objectiveId,
                        )
                        .map((objective) => (
                          <option key={objective.id} value={objective.id}>
                            {objective.ref} · {objective.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Tipo
                    <select
                      value={workDraft.kind}
                      onChange={(event) =>
                        setWorkDraft({
                          ...workDraft,
                          kind: event.target.value as WorkGraphItem["kind"],
                        })
                      }
                    >
                      <option value="task">Task</option>
                      <option value="story">Story</option>
                      <option value="bug">Bug</option>
                      <option value="spike">Spike</option>
                    </select>
                  </label>
                  <label>
                    Prioridade
                    <PrioritySelect
                      value={workDraft.priority}
                      onChange={(priority) =>
                        setWorkDraft({ ...workDraft, priority })
                      }
                    />
                  </label>
                  <label>
                    Adapter externo
                    <input value="GitHub Issues · roadmap" disabled />
                  </label>
                </div>
              </>
            )}
            {error && (
              <p className="workspace-form-error" role="alert">
                {error}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="text-button"
                disabled={editorSaving}
                onClick={() => setEditor(null)}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={editorSaving || conflicted}
              >
                {editorSaving
                  ? "Salvando…"
                  : conflicted
                    ? "Reabra para reconciliar"
                    : "Salvar"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}

function ObjectiveDetail({
  objective,
  pending,
  onEdit,
  onTransition,
}: {
  objective?: WorkGraphObjective;
  pending: boolean;
  onEdit: (objective: WorkGraphObjective) => void;
  onTransition: (
    objective: WorkGraphObjective,
    status: WorkGraphObjective["status"],
  ) => void;
}) {
  if (!objective) return null;
  return (
    <div className="objective-detail">
      <span>
        <small>{objective.ref}</small>
        <b>{objective.title}</b>
        <p>{objective.description || "Sem contexto adicional."}</p>
      </span>
      <div>
        <button disabled={pending} onClick={() => onEdit(objective)}>
          Editar
        </button>
        {objective.status === "open" && (
          <button
            disabled={pending}
            onClick={() => void onTransition(objective, "active")}
          >
            Ativar
          </button>
        )}
        {objective.status === "active" && (
          <>
            <button
              disabled={pending}
              onClick={() => void onTransition(objective, "completed")}
            >
              Concluir
            </button>
            <button
              className="danger-text"
              disabled={pending}
              onClick={() => void onTransition(objective, "cancelled")}
            >
              Cancelar
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function PrioritySelect({
  value,
  onChange,
}: {
  value: WorkGraphObjective["priority"];
  onChange: (value: WorkGraphObjective["priority"]) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) =>
        onChange(event.target.value as WorkGraphObjective["priority"])
      }
    >
      <option value="p0">P0 · Critical</option>
      <option value="p1">P1 · High</option>
      <option value="p2">P2 · Normal</option>
      <option value="p3">P3 · Low</option>
    </select>
  );
}

function statusLabel(status: WorkGraphItem["status"]) {
  return status.replaceAll("_", " ");
}

function workGraphError(code?: string) {
  const messages: Record<string, string> = {
    version_conflict:
      "O registro mudou em outra sessão. Feche e reabra o editor para reconciliar a versão atual.",
    invalid_status_transition: "Essa transição não é permitida.",
    objective_has_active_work_items:
      "Conclua ou cancele o trabalho ativo antes de encerrar o objetivo.",
    invalid_reference:
      "Projeto, objetivo ou responsável não está mais disponível.",
    invalid_title: "Informe um título válido.",
    invalid_description: "A descrição excede o limite permitido.",
  };
  return messages[code ?? ""] ?? "Não foi possível concluir a operação.";
}
