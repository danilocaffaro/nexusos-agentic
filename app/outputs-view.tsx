"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArtifactDetail,
  ArtifactErasureImpact,
  ArtifactSummary,
  ArtifactVersionContent,
} from "@/src/contracts/artifacts";

export type OutputsWorkspace = {
  projects: Array<{ id: string; name: string; status: string }>;
  workItems: Array<{
    id: string;
    project_id: string;
    ref: string;
    title: string;
    status: string;
  }>;
};

type Props = {
  workspace: OutputsWorkspace | null;
  initialWorkItemId?: string;
  onInitialWorkItemConsumed?: () => void;
  initialArtifactId?: string;
  onInitialArtifactConsumed?: () => void;
  onErasureIntentProposed?: (intentId: string) => void;
  notify: (message: string) => void;
};

type EditorState =
  | { kind: "create" }
  | { kind: "version"; artifact: ArtifactDetail };

export function OutputsView({
  workspace,
  initialWorkItemId,
  onInitialWorkItemConsumed,
  initialArtifactId,
  onInitialArtifactConsumed,
  onErasureIntentProposed,
  notify,
}: Props) {
  const eligibleWorkItems = useMemo(
    () => workspace?.workItems ?? [],
    [workspace],
  );
  const [selectedWorkItemId, setSelectedWorkItemId] = useState(
    initialWorkItemId ?? "",
  );
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [versionContent, setVersionContent] =
    useState<ArtifactVersionContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [erasureImpact, setErasureImpact] =
    useState<ArtifactErasureImpact | null>(null);
  const [erasureReason, setErasureReason] = useState("");
  const [erasureLoading, setErasureLoading] = useState(false);
  const [erasureError, setErasureError] = useState("");
  const listRequestRef = useRef(0);

  const activeWorkItemId =
    initialWorkItemId &&
    eligibleWorkItems.some((item) => item.id === initialWorkItemId)
      ? initialWorkItemId
      : eligibleWorkItems.some((item) => item.id === selectedWorkItemId)
        ? selectedWorkItemId
        : eligibleWorkItems[0]?.id ?? "";

  useEffect(() => {
    if (
      initialWorkItemId &&
      eligibleWorkItems.some((item) => item.id === initialWorkItemId)
    ) {
      onInitialWorkItemConsumed?.();
    }
  }, [
    eligibleWorkItems,
    initialWorkItemId,
    onInitialWorkItemConsumed,
  ]);

  useEffect(() => {
    if (!initialArtifactId || eligibleWorkItems.length === 0) return;
    let active = true;
    fetch(`/api/artifacts/${initialArtifactId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("artifact_link_failed");
        return response.json() as Promise<ArtifactDetail>;
      })
      .then((state) => {
        if (!active) return;
        if (!eligibleWorkItems.some((item) => item.id === state.workItemId)) {
          throw new Error("artifact_work_item_unavailable");
        }
        if (state.workItemId !== activeWorkItemId) {
          listRequestRef.current += 1;
        }
        setSelectedWorkItemId(state.workItemId);
        setSelectedArtifactId(state.id);
        setDetail(state);
        setSelectedVersion(state.currentVersion);
        setError("");
        onInitialArtifactConsumed?.();
      })
      .catch(() => {
        if (active) {
          setError("O link aponta para um output indisponível.");
          onInitialArtifactConsumed?.();
        }
      });
    return () => {
      active = false;
    };
  }, [
    eligibleWorkItems,
    activeWorkItemId,
    initialArtifactId,
    onInitialArtifactConsumed,
  ]);

  const loadArtifacts = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (!activeWorkItemId) {
      setArtifacts([]);
      setSelectedArtifactId("");
      setDetail(null);
      setSelectedVersion(null);
      setVersionContent(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/work-items/${activeWorkItemId}/artifacts`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        artifacts?: ArtifactSummary[];
        error?: string;
      };
      if (!response.ok || !payload.artifacts) {
        throw new Error(payload.error ?? "artifact_list_failed");
      }
      if (!isCurrentArtifactListRequest(requestId, listRequestRef.current)) {
        return;
      }
      setArtifacts(payload.artifacts);
      if (payload.artifacts.length === 0) {
        setDetail(null);
        setSelectedVersion(null);
        setVersionContent(null);
      }
      setSelectedArtifactId((current) =>
        payload.artifacts?.some((item) => item.id === current)
          ? current
          : payload.artifacts?.[0]?.id ?? "",
      );
    } catch {
      if (!isCurrentArtifactListRequest(requestId, listRequestRef.current)) {
        return;
      }
      setArtifacts([]);
      setSelectedArtifactId("");
      setDetail(null);
      setSelectedVersion(null);
      setVersionContent(null);
      setError("Não foi possível carregar os outputs deste Work Item.");
    } finally {
      if (isCurrentArtifactListRequest(requestId, listRequestRef.current)) {
        setLoading(false);
      }
    }
  }, [activeWorkItemId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadArtifacts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadArtifacts]);

  useEffect(() => {
    if (!selectedArtifactId) return;
    let active = true;
    fetch(`/api/artifacts/${selectedArtifactId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("artifact_detail_failed");
        return response.json() as Promise<ArtifactDetail>;
      })
      .then((state) => {
        if (!active) return;
        setDetail(state);
        setSelectedVersion(state.currentVersion);
        setError("");
      })
      .catch(() => {
        if (active) {
          setDetail(null);
          setError("O output selecionado não está mais disponível.");
        }
      });
    return () => {
      active = false;
    };
  }, [selectedArtifactId]);

  useEffect(() => {
    if (!selectedArtifactId || !selectedVersion) return;
    let active = true;
    fetch(
      `/api/artifacts/${selectedArtifactId}/versions/${selectedVersion}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("artifact_version_failed");
        return response.json() as Promise<ArtifactVersionContent>;
      })
      .then((state) => {
        if (active) {
          setVersionContent(state);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError("Não foi possível abrir esta versão.");
      });
    return () => {
      active = false;
    };
  }, [selectedArtifactId, selectedVersion]);

  const selectedWorkItem = eligibleWorkItems.find(
    (item) => item.id === activeWorkItemId,
  );
  const projectName =
    workspace?.projects.find(
      (project) => project.id === selectedWorkItem?.project_id,
    )?.name ?? "Projeto";
  const versionCount = artifacts.reduce(
    (total, artifact) => total + artifact.currentVersion,
    0,
  );
  const activeVersionContent =
    versionContent?.artifactId === selectedArtifactId &&
    versionContent.versionNumber === selectedVersion
      ? versionContent
      : null;

  const openCreate = () => {
    setTitle("");
    setNote("");
    setContent("# Output\n\n");
    setConflicted(false);
    setError("");
    setEditor({ kind: "create" });
  };

  const openAppend = async () => {
    if (!detail) return;
    let currentContent =
      versionContent?.artifactId === detail.id &&
      versionContent.versionNumber === detail.currentVersion
        ? versionContent.content
        : null;
    if (currentContent === null) {
      const response = await fetch(
        `/api/artifacts/${detail.id}/versions/${detail.currentVersion}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        setError("Não foi possível carregar a versão atual para edição.");
        return;
      }
      const current = (await response.json()) as ArtifactVersionContent;
      if (current.content === null) {
        setError("A versão atual não possui payload editável.");
        return;
      }
      currentContent = current.content;
    }
    setTitle(detail.title);
    setNote("");
    setContent(currentContent);
    setConflicted(false);
    setError("");
    setEditor({ kind: "version", artifact: detail });
  };

  const save = async () => {
    if (!editor || !activeWorkItemId || conflicted) return;
    setSaving(true);
    setConflicted(false);
    setError("");
    const isCreate = editor.kind === "create";
    const path = isCreate
      ? `/api/work-items/${activeWorkItemId}/artifacts`
      : `/api/artifacts/${editor.artifact.id}/versions`;
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          isCreate
            ? { title, content, note, mediaType: "text/markdown" }
            : {
                expectedVersion: editor.artifact.currentVersion,
                content,
                note,
              },
        ),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        id?: string;
        artifactId?: string;
        error?: string;
      };
      if (!response.ok) {
        setError(artifactError(payload.error));
        if (response.status === 409 && !isCreate) {
          setConflicted(true);
          await loadArtifacts();
          const latestResponse = await fetch(
            `/api/artifacts/${editor.artifact.id}`,
            { cache: "no-store" },
          );
          if (latestResponse.ok) {
            const latest = (await latestResponse.json()) as ArtifactDetail;
            setDetail(latest);
            setEditor({ kind: "version", artifact: latest });
            setSelectedVersion(latest.currentVersion);
            setVersionContent(null);
          }
        }
        return;
      }
      setEditor(null);
      await loadArtifacts();
      const artifactId = payload.id ?? payload.artifactId;
      if (artifactId) setSelectedArtifactId(artifactId);
      if (!isCreate) {
        const latestResponse = await fetch(
          `/api/artifacts/${editor.artifact.id}`,
          { cache: "no-store" },
        );
        if (latestResponse.ok) {
          const latest = (await latestResponse.json()) as ArtifactDetail;
          setDetail(latest);
          setSelectedVersion(latest.currentVersion);
        }
      }
      notify(isCreate ? "Output registrado no D1" : "Nova versão publicada");
    } catch {
      setError("A operação não chegou ao registro de artifacts.");
    } finally {
      setSaving(false);
    }
  };

  const openErasureReview = async () => {
    if (!detail || !selectedVersion) return;
    setErasureLoading(true);
    setErasureError("");
    try {
      const response = await fetch(
        `/api/artifacts/${detail.id}/versions/${selectedVersion}/erasure-intents`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => ({}))) as
        | ArtifactErasureImpact
        | { error?: string };
      if (!response.ok || !("contentHash" in payload)) {
        throw new Error(
          "error" in payload ? payload.error : "erasure_impact_failed",
        );
      }
      setErasureImpact(payload);
      setErasureReason("");
      setError("");
    } catch (error) {
      const message = artifactErasureError(
        error instanceof Error ? error.message : undefined,
      );
      setErasureError(message);
      setError(message);
    } finally {
      setErasureLoading(false);
    }
  };

  const proposeErasure = async () => {
    if (!erasureImpact) return;
    setErasureLoading(true);
    setErasureError("");
    try {
      const response = await fetch(
        `/api/artifacts/${erasureImpact.artifactId}/versions/${erasureImpact.versionNumber}/erasure-intents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: erasureReason }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        intent?: { id: string };
        error?: string;
      };
      if (!response.ok || !payload.intent) {
        throw new Error(payload.error ?? "erasure_proposal_failed");
      }
      setErasureImpact(null);
      notify("Erasure proposta; aprovação humana obrigatória");
      onErasureIntentProposed?.(payload.intent.id);
    } catch (error) {
      setErasureError(
        artifactErasureError(
          error instanceof Error ? error.message : undefined,
        ),
      );
    } finally {
      setErasureLoading(false);
    }
  };

  return (
    <div className="view-page outputs-page" data-testid="outputs-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">ARTIFACT REGISTRY · REAL</span>
          <h1>Outputs dos times</h1>
          <p>
            Markdown versionado e rastreável, sem dependência de GitHub ou
            storage pago.
          </p>
        </div>
        <button
          className="primary-button compact"
          disabled={!activeWorkItemId}
          onClick={openCreate}
        >
          ＋ Publicar output
        </button>
      </div>

      <div className="real-data-disclosure">
        <b>REAL · LOCAL D1</b>
        <span>
          Conteúdo fora do registro imutável, hash SHA-256 calculado no servidor
          e concorrência protegida por versão esperada.
        </span>
      </div>

      <section className="artifact-summary">
        <div>
          <small>OUTPUTS DO WORK ITEM</small>
          <b>{artifacts.length}</b>
          <em>persistentes</em>
        </div>
        <div>
          <small>VERSÕES</small>
          <b>{versionCount}</b>
          <em>append-only</em>
        </div>
        <div>
          <small>INTEGRIDADE</small>
          <b>SHA-256</b>
          <em>server verified</em>
        </div>
        <div>
          <small>FORMATO</small>
          <b>MD</b>
          <em>até 256 KiB</em>
        </div>
      </section>

      <label className="artifact-work-item-picker">
        Work Item
        <select
          value={activeWorkItemId}
          onChange={(event) => {
            listRequestRef.current += 1;
            setSelectedWorkItemId(event.target.value);
            setArtifacts([]);
            setSelectedArtifactId("");
            setDetail(null);
            setSelectedVersion(null);
            setVersionContent(null);
          }}
        >
          {eligibleWorkItems.map((item) => (
            <option key={item.id} value={item.id}>
              {item.ref} · {item.title}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p className="workspace-form-error" role="alert">
          {error}
        </p>
      )}

      {!workspace && (
        <section className="workspace-state-banner is-loading">
          <span>
            <b>Carregando Work Graph…</b>
            <small>Outputs dependem apenas do núcleo local</small>
          </span>
        </section>
      )}

      {workspace && eligibleWorkItems.length === 0 && (
        <section className="workspace-empty-state">
          <span>01</span>
          <div>
            <h2>Crie um Work Item antes do primeiro output</h2>
            <p>Todo artifact nasce ligado a trabalho e projeto reais.</p>
          </div>
        </section>
      )}

      {selectedWorkItem && (
        <div className="artifact-workspace">
          <section
            className="artifact-directory"
            aria-busy={loading}
            aria-label={`Outputs de ${selectedWorkItem.ref}`}
          >
            <div className="artifact-toolbar">
              <div>
                <b>{selectedWorkItem.ref}</b>
                <span>{selectedWorkItem.title}</span>
              </div>
              <small>{projectName}</small>
            </div>
            <div className="artifact-table-head">
              <span>OUTPUT</span>
              <span>WORK ITEM / CREATOR</span>
              <span>VERSÃO</span>
              <span>HASH</span>
              <span>UPDATED</span>
            </div>
            {artifacts.map((artifact) => (
              <button
                className={`artifact-row ${
                  selectedArtifactId === artifact.id ? "is-selected" : ""
                }`}
                key={artifact.id}
                onClick={() => {
                  setSelectedArtifactId(artifact.id);
                  setDetail(null);
                  setSelectedVersion(null);
                  setVersionContent(null);
                  setError("");
                }}
              >
                <span className="artifact-symbol tone-violet">MD</span>
                <span>
                  <b>{artifact.title}</b>
                  <small>{formatBytes(artifact.currentByteSize)}</small>
                </span>
                <span>
                  <b>{artifact.workItemRef}</b>
                  <small>by {artifact.createdBy.displayName}</small>
                </span>
                <code>v{artifact.currentVersion}</code>
                <code>{artifact.currentContentHash.slice(0, 10)}…</code>
                <time>{formatTimestamp(artifact.updatedAt)}</time>
              </button>
            ))}
            {!loading && artifacts.length === 0 && (
              <div className="artifact-empty">
                <span>◇</span>
                <b>Nenhum output ainda</b>
                <p>Publique o primeiro Markdown deste Work Item.</p>
                <button onClick={openCreate}>＋ Publicar output</button>
              </div>
            )}
          </section>

          <aside className="artifact-detail">
            {detail ? (
              <>
                <span className="eyebrow">SELECTED OUTPUT · REAL</span>
                <div className="artifact-symbol detail-symbol tone-violet">
                  MD
                </div>
                <h2>{detail.title}</h2>
                <p>
                  {detail.workItemRef} · {detail.workItemTitle}
                </p>
                <div className="artifact-actions">
                  <button
                    className="primary-button compact"
                    onClick={() => void openAppend()}
                  >
                    ＋ Nova versão
                  </button>
                  <button
                    className="outline-button"
                    onClick={() => {
                      const link = new URL(window.location.href);
                      link.search = "";
                      link.searchParams.set("artifact", detail.id);
                      void navigator.clipboard?.writeText(
                        link.toString(),
                      );
                      notify("Link do output copiado");
                    }}
                  >
                    Copiar link
                  </button>
                  <button
                    className="outline-button danger-outline"
                    disabled={
                      !selectedVersion ||
                      activeVersionContent?.content === null
                    }
                    onClick={() => void openErasureReview()}
                  >
                    Solicitar erasure
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>Created by</dt>
                    <dd>{detail.createdBy.displayName}</dd>
                  </div>
                  <div>
                    <dt>Project</dt>
                    <dd>{detail.projectName}</dd>
                  </div>
                  <div>
                    <dt>Current</dt>
                    <dd>v{detail.currentVersion}</dd>
                  </div>
                  <div>
                    <dt>Integrity</dt>
                    <dd>✓ SHA-256</dd>
                  </div>
                </dl>
                <div className="artifact-version-history">
                  <span className="eyebrow">VERSION HISTORY</span>
                  {detail.versions.map((version) => (
                    <button
                      key={version.versionNumber}
                      className={
                        selectedVersion === version.versionNumber
                          ? "is-active"
                          : ""
                      }
                      onClick={() => setSelectedVersion(version.versionNumber)}
                    >
                      <span>
                        <b>v{version.versionNumber}</b>
                        <small>
                          {version.note || "Sem nota"} ·{" "}
                          {version.createdBy.displayName}
                        </small>
                      </span>
                      <code>{version.contentHash.slice(0, 10)}…</code>
                    </button>
                  ))}
                </div>
                <div className="artifact-markdown-preview">
                  <header>
                    <span>
                      v{selectedVersion ?? detail.currentVersion} · conteúdo
                      literal
                    </span>
                    <code>
                      {activeVersionContent?.contentHash.slice(0, 12) ??
                        "loading"}…
                    </code>
                  </header>
                  <pre>
                    {activeVersionContent?.content ??
                      (activeVersionContent?.erasedAt
                        ? "Payload apagado por política governada."
                        : "Carregando conteúdo…")}
                  </pre>
                </div>
                <div className="lineage-card">
                  <span className="eyebrow">LINEAGE · S5.B1</span>
                  <div>
                    <span>{detail.projectName}</span>
                    <i>→</i>
                    <span>{detail.workItemRef}</span>
                    <i>→</i>
                    <b>v{selectedVersion ?? detail.currentVersion}</b>
                  </div>
                </div>
              </>
            ) : (
              <div className="artifact-detail-empty">
                <span>◇</span>
                <b>Selecione um output</b>
                <p>Versões, hash, produtor e conteúdo aparecem aqui.</p>
              </div>
            )}
          </aside>
        </div>
      )}

      {editor && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!saving) setEditor(null);
          }}
        >
          <form
            className="entity-editor artifact-editor"
            role="dialog"
            aria-modal="true"
            aria-label={
              editor.kind === "create"
                ? "Publicar output"
                : "Publicar nova versão"
            }
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <header>
              <div>
                <span className="eyebrow">OUTPUT STUDIO · REAL</span>
                <h2>
                  {editor.kind === "create"
                    ? "Publicar output"
                    : `Nova versão de ${editor.artifact.title}`}
                </h2>
                <p>Markdown literal, hash no servidor e histórico append-only.</p>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditor(null)}
              >
                ×
              </button>
            </header>
            {editor.kind === "create" && (
              <label>
                Título
                <input
                  required
                  maxLength={160}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            )}
            <label>
              Nota da versão
              <input
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="O que esta versão acrescenta?"
              />
            </label>
            <label>
              Conteúdo Markdown
              <textarea
                required
                className="artifact-content-editor"
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
              <small>{formatBytes(new TextEncoder().encode(content).byteLength)} / 256 KiB</small>
            </label>
            {conflicted && (
              <div className="artifact-conflict" role="alert">
                <b>Uma versão mais nova já existe.</b>
                <span>
                  A publicação foi bloqueada. Feche este editor, revise a versão
                  atual e abra “Nova versão” novamente.
                </span>
              </div>
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
                disabled={saving}
                onClick={() => setEditor(null)}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={!canSubmitArtifactEditor({
                  saving,
                  conflicted,
                  content,
                  title,
                  requiresTitle: editor.kind === "create",
                })}
              >
                {saving ? "Publicando…" : "Publicar versão"}
              </button>
            </footer>
          </form>
        </div>
      )}
      {erasureImpact && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!erasureLoading) setErasureImpact(null);
          }}
        >
          <form
            className="entity-editor artifact-erasure-review"
            role="dialog"
            aria-modal="true"
            aria-label="Revisar erasure de payload"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void proposeErasure();
            }}
          >
            <header>
              <div>
                <span className="eyebrow">GOVERNED ERASURE · REAL</span>
                <h2>Retirar conteúdo de circulação</h2>
                <p>
                  Esta etapa apenas propõe um ActionIntent. O payload só fica
                  indisponível após aprovação humana e execução governada.
                </p>
              </div>
              <button
                type="button"
                disabled={erasureLoading}
                onClick={() => setErasureImpact(null)}
              >
                ×
              </button>
            </header>
            <div className="erasure-honesty">
              <b>APAGAMENTO LÓGICO</b>
              <span>
                O corpo deixa de ser servido; hash, tamanho, lineage e eventos
                permanecem. Isto não é cryptographic shredding de backups.
              </span>
            </div>
            <div className="erasure-impact-grid">
              <span>
                <small>VERSÕES AFETADAS</small>
                <b>{erasureImpact.referenceCount}</b>
              </span>
              <span>
                <small>CÓPIAS VIVAS</small>
                <b>{erasureImpact.livePayloadCount}</b>
              </span>
              <span>
                <small>HASH</small>
                <code>{erasureImpact.contentHash.slice(0, 12)}…</code>
              </span>
            </div>
            <div className="erasure-version-list">
              {erasureImpact.versions.map((version) => (
                <span
                  key={`${version.artifactId}:${version.versionNumber}`}
                >
                  <b>{version.artifactTitle}</b>
                  <small>
                    {version.workItemRef} · v{version.versionNumber}
                  </small>
                </span>
              ))}
            </div>
            <label>
              Reason why
              <textarea
                required
                minLength={10}
                maxLength={500}
                value={erasureReason}
                onChange={(event) => setErasureReason(event.target.value)}
                placeholder="Explique a política, retenção ou necessidade que justifica tornar este conteúdo indisponível."
              />
            </label>
            {erasureError && (
              <p className="workspace-form-error" role="alert">
                {erasureError}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="text-button"
                disabled={erasureLoading}
                onClick={() => setErasureImpact(null)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="primary-button danger-button"
                disabled={
                  erasureLoading || erasureReason.trim().length < 10
                }
              >
                {erasureLoading
                  ? "Propondo…"
                  : "Propor ActionIntent de erasure"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

export function isCurrentArtifactListRequest(
  requestId: number,
  currentRequestId: number,
): boolean {
  return requestId === currentRequestId;
}

export function canSubmitArtifactEditor(input: {
  saving: boolean;
  conflicted: boolean;
  content: string;
  title: string;
  requiresTitle: boolean;
}): boolean {
  return (
    !input.saving &&
    !input.conflicted &&
    input.content.length > 0 &&
    (!input.requiresTitle || input.title.trim().length > 0)
  );
}

function artifactError(code?: string): string {
  const messages: Record<string, string> = {
    invalid_artifact_title: "Informe um título entre 1 e 160 caracteres.",
    invalid_artifact_content: "O conteúdo Markdown não pode ficar vazio.",
    artifact_content_too_large: "O conteúdo excede o limite de 256 KiB.",
    invalid_artifact_note: "A nota deve ter no máximo 500 caracteres.",
    artifact_version_conflict:
      "Este output recebeu uma nova versão enquanto você editava.",
    work_item_not_found: "O Work Item não está mais disponível.",
  };
  return messages[code ?? ""] ?? "Não foi possível publicar este output.";
}

function artifactErasureError(code?: string): string {
  const messages: Record<string, string> = {
    invalid_artifact_erasure_reason:
      "Explique a necessidade em 10 a 500 caracteres.",
    artifact_erasure_scope_too_large:
      "O blast radius excede o limite deste fluxo; escale para revisão administrativa.",
    artifact_content_hash_conflict:
      "A integridade deste conteúdo está inconsistente; nenhuma ação foi proposta.",
    idempotency_key_reused:
      "Já existe uma proposta para este blast radius com outro contexto.",
  };
  return (
    messages[code ?? ""] ??
    "Não foi possível preparar a proposta de erasure."
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
