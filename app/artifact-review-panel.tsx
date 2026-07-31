"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArtifactReviewReasonCode,
  ArtifactReviewState,
  ArtifactReviewVerdict,
} from "@/src/contracts/artifacts";

type Props = {
  artifactId: string;
  versionNumber: number;
  notify: (message: string) => void;
};

const REASONS: Record<
  ArtifactReviewVerdict,
  Array<{ value: ArtifactReviewReasonCode; label: string }>
> = {
  approved: [
    { value: "accurate", label: "Conteúdo preciso" },
    { value: "complete", label: "Escopo completo" },
  ],
  changes_requested: [
    { value: "needs_correction", label: "Precisa de correção" },
    { value: "needs_evidence", label: "Precisa de evidência" },
    { value: "outdated", label: "Conteúdo desatualizado" },
  ],
};

export function ArtifactReviewPanel({
  artifactId,
  versionNumber,
  notify,
}: Props) {
  const [state, setState] = useState<ArtifactReviewState | null>(null);
  const [verdict, setVerdict] =
    useState<ArtifactReviewVerdict>("approved");
  const [reasonCode, setReasonCode] =
    useState<ArtifactReviewReasonCode>("accurate");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const loadReviews = useCallback(async (preserveDraft = false) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(reviewUrl(artifactId, versionNumber), {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as
        | ArtifactReviewState
        | { error?: string };
      if (!response.ok || !("reviews" in payload)) {
        throw new Error(
          "error" in payload ? payload.error : "review_list_failed",
        );
      }
      if (requestId !== requestRef.current) return;
      setState(payload);
      const mine = payload.reviews.find(
        (review) => review.id === payload.myActiveReviewId,
      );
      if (mine && !preserveDraft) {
        setVerdict(mine.verdict);
        setReasonCode(mine.reasonCode);
      }
    } catch {
      if (requestId !== requestRef.current) return;
      setState(null);
      setError("Não foi possível carregar as revisões desta versão.");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [artifactId, versionNumber]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadReviews(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current += 1;
    };
  }, [loadReviews]);

  const options = useMemo(() => reviewReasonOptions(verdict), [verdict]);
  const approvalBlocked =
    verdict === "approved" &&
    (state?.selfReviewApproval === "independent_required" ||
      state?.selfReviewApproval === "owner_role_required");
  const acknowledgementRequired =
    verdict === "approved" &&
    state?.selfReviewApproval === "solo_owner_ack";
  const payloadErased = Boolean(state?.erasedAt);
  const submitBlocked =
    loading ||
    saving ||
    !state ||
    payloadErased ||
    approvalBlocked ||
    (acknowledgementRequired && !acknowledged);
  const activeReviews =
    state?.reviews.filter((review) => review.status === "active") ?? [];
  const supersededReviews =
    state?.reviews.filter((review) => review.status === "superseded") ?? [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitBlocked) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(reviewUrl(artifactId, versionNumber), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verdict,
          reasonCode,
          ...(acknowledgementRequired
            ? { soloOwnerAcknowledged: true }
            : {}),
          ...(state.myActiveReviewId
            ? { expectedReviewId: state.myActiveReviewId }
            : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        created?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "review_record_failed");
      }
      notify(
        payload.created === false
          ? "Esta revisão já estava registrada"
          : "Revisão registrada no ledger",
      );
      setAcknowledged(false);
      await loadReviews();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : undefined;
      if (
        code === "review_conflict" ||
        code === "artifact_review_stale"
      ) {
        await loadReviews(true);
      }
      setError(artifactReviewError(code));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="artifact-review-panel"
      aria-busy={loading || saving}
      data-testid="artifact-review-panel"
    >
      <header>
        <span>
          <span className="eyebrow">VERSION REVIEW · PERSISTENTE</span>
          <b>Revisão advisory da v{versionNumber}</b>
        </span>
        <code>{state?.contentHash.slice(0, 10) ?? "loading"}…</code>
      </header>
      <p>
        Veredito por pessoa e versão imutável. Não altera o output, não executa
        ações e não aceita comentário livre permanente.
      </p>

      {payloadErased && (
        <div className="artifact-review-notice is-erased">
          <b>PAYLOAD APAGADO</b>
          <span>
            O histórico metadata-only permanece verificável; novas revisões
            estão bloqueadas porque o conteúdo não pode mais ser inspecionado.
          </span>
        </div>
      )}

      <div className="artifact-review-summary">
        <span>
          <b>{activeReviews.length}</b>
          <small>opiniões ativas</small>
        </span>
        <span>
          <b>{supersededReviews.length}</b>
          <small>opiniões anteriores</small>
        </span>
      </div>

      {activeReviews.length > 0 ? (
        <div className="artifact-review-list">
          {activeReviews.map((review) => (
            <article key={review.id}>
              <span
                className={`artifact-review-verdict is-${review.verdict}`}
              >
                {review.verdict === "approved"
                  ? "APROVADO"
                  : "MUDANÇAS"}
              </span>
              <span>
                <b>{review.reviewer.displayName}</b>
                <small>{reviewReasonLabel(review.reasonCode)}</small>
              </span>
              {review.id === state?.myActiveReviewId && (
                <em>VOCÊ</em>
              )}
              <time>{formatReviewTime(review.createdAt)}</time>
            </article>
          ))}
        </div>
      ) : (
        <div className="artifact-review-empty">
          Nenhuma opinião ativa para esta versão.
        </div>
      )}

      <form onSubmit={submit}>
        <div className="artifact-review-fields">
          <label>
            Veredito
            <select
              value={verdict}
              disabled={loading || saving || payloadErased}
              onChange={(event) => {
                const next = event.target.value as ArtifactReviewVerdict;
                setVerdict(next);
                setReasonCode(reviewReasonOptions(next)[0].value);
                setAcknowledged(false);
              }}
            >
              <option value="approved">Aprovar</option>
              <option value="changes_requested">Solicitar mudanças</option>
            </select>
          </label>
          <label>
            Motivo padronizado
            <select
              value={reasonCode}
              disabled={loading || saving || payloadErased}
              onChange={(event) =>
                setReasonCode(
                  event.target.value as ArtifactReviewReasonCode,
                )
              }
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {approvalBlocked && (
          <div className="artifact-review-notice" role="status">
            <b>
              {state?.selfReviewApproval === "owner_role_required"
                ? "OWNER NECESSÁRIO PARA A EXCEÇÃO"
                : "REVISOR INDEPENDENTE NECESSÁRIO"}
            </b>
            <span>
              {state?.selfReviewApproval === "owner_role_required"
                ? "Você produziu esta versão, mas a exceção de self-review é exclusiva do único owner humano. Ainda pode solicitar mudanças no próprio trabalho."
                : "Você produziu esta versão e existe outra pessoa elegível no workspace. Ainda pode solicitar mudanças no próprio trabalho."}
            </span>
          </div>
        )}

        {acknowledgementRequired && (
          <label className="artifact-review-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={saving || payloadErased}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              Confirmo que sou o único owner humano elegível neste instante e
              aceito o registro explícito de self-review no ledger.
            </span>
          </label>
        )}

        {error && (
          <p className="workspace-form-error" role="alert">
            {error}
          </p>
        )}

        <button
          className="primary-button compact"
          type="submit"
          disabled={submitBlocked}
        >
          {saving
            ? "Registrando…"
            : state?.myActiveReviewId
              ? "Substituir minha revisão"
              : "Registrar revisão"}
        </button>
      </form>

      {supersededReviews.length > 0 && (
        <details className="artifact-review-history">
          <summary>
            Histórico substituído · {supersededReviews.length}
          </summary>
          {supersededReviews.map((review) => (
            <div key={review.id}>
              <span>
                {review.reviewer.displayName} ·{" "}
                {review.verdict === "approved" ? "aprovou" : "pediu mudanças"}
              </span>
              <code>{reviewReasonLabel(review.reasonCode)}</code>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

export function reviewReasonOptions(verdict: ArtifactReviewVerdict) {
  return REASONS[verdict];
}

function reviewReasonLabel(reason: ArtifactReviewReasonCode): string {
  for (const options of Object.values(REASONS)) {
    const match = options.find((option) => option.value === reason);
    if (match) return match.label;
  }
  return reason;
}

function reviewUrl(artifactId: string, versionNumber: number): string {
  return `/api/artifacts/${encodeURIComponent(
    artifactId,
  )}/versions/${versionNumber}/reviews`;
}

function artifactReviewError(code?: string): string {
  const messages: Record<string, string> = {
    invalid_artifact_review:
      "O veredito e o motivo padronizado não são compatíveis.",
    invalid_review_verdict:
      "Selecione um veredito permitido para esta versão.",
    invalid_review_reason:
      "O motivo padronizado não é compatível com o veredito.",
    invalid_review_request:
      "A solicitação contém campos ou referências de revisão inválidos.",
    independent_artifact_reviewer_required:
      "Outra pessoa elegível precisa aprovar esta versão.",
    artifact_review_owner_required:
      "A exceção de self-review exige o papel de owner.",
    self_review_ack_required:
      "Confirme a exceção de único owner antes de aprovar.",
    artifact_payload_erased:
      "Esta versão não pode mais ser revisada porque o payload foi apagado.",
    artifact_review_stale:
      "A versão mudou de estado. Atualizamos os dados e preservamos sua seleção.",
    review_conflict:
      "Outra revisão venceu a concorrência. Atualizamos os dados e preservamos sua seleção.",
    workspace_contributor_required:
      "Seu papel pode consultar, mas não registrar revisões.",
  };
  return (
    messages[code ?? ""] ??
    "Não foi possível registrar a revisão desta versão."
  );
}

function formatReviewTime(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
