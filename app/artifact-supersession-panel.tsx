"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArtifactSupersessionReasonCode,
  ArtifactSupersessionRetractionReasonCode,
  ArtifactSupersessionState,
} from "@/src/contracts/artifacts";

type Props = {
  artifactId: string;
  sourceVersionNumber: number;
  notify: (message: string) => void;
};

const REASONS: Array<{
  value: ArtifactSupersessionReasonCode;
  label: string;
}> = [
  { value: "replaced_by_revision", label: "Substituído por revisão" },
  { value: "duplicate_output", label: "Output duplicado" },
  { value: "scope_moved", label: "Escopo movido" },
];

const RETRACTION_REASONS: Array<{
  value: ArtifactSupersessionRetractionReasonCode;
  label: string;
}> = [
  { value: "declared_in_error", label: "Declarado por engano" },
  { value: "no_longer_accurate", label: "Relação não é mais precisa" },
];

export function ArtifactSupersessionPanel({
  artifactId,
  sourceVersionNumber,
  notify,
}: Props) {
  const [state, setState] = useState<ArtifactSupersessionState | null>(null);
  const [targetArtifactId, setTargetArtifactId] = useState("");
  const [reasonCode, setReasonCode] =
    useState<ArtifactSupersessionReasonCode>("replaced_by_revision");
  const [retractionReasonCode, setRetractionReasonCode] =
    useState<ArtifactSupersessionRetractionReasonCode>(
      "no_longer_accurate",
    );
  const [retractionAcknowledged, setRetractionAcknowledged] =
    useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const loadState = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(supersessionUrl(artifactId), {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as
        | ArtifactSupersessionState
        | { error?: string };
      if (!response.ok || !("candidates" in payload)) {
        throw new Error(
          "error" in payload ? payload.error : "supersession_list_failed",
        );
      }
      if (requestId !== requestRef.current) return;
      setState(payload);
      setTargetArtifactId((current) => {
        if (
          payload.candidates.some(
            (candidate) =>
              candidate.artifactId === current &&
              candidate.contentAvailable,
          )
        ) {
          return current;
        }
        return (
          payload.candidates.find((candidate) => candidate.contentAvailable)
            ?.artifactId ?? ""
        );
      });
    } catch {
      if (requestId !== requestRef.current) return;
      setState(null);
      setError("Não foi possível carregar a navegação entre outputs.");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [artifactId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadState(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current += 1;
    };
  }, [loadState, sourceVersionNumber]);

  const selectedCandidate = useMemo(
    () =>
      state?.candidates.find(
        (candidate) => candidate.artifactId === targetArtifactId,
      ),
    [state, targetArtifactId],
  );

  const declare = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      saving ||
      !state?.canGovern ||
      state.active ||
      !selectedCandidate?.contentAvailable
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(supersessionUrl(artifactId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetArtifactId: selectedCandidate.artifactId,
          sourceVersionNumber,
          targetVersionNumber: selectedCandidate.currentVersionNumber,
          reasonCode,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        created?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "supersession_declare_failed");
      }
      notify(
        payload.created === false
          ? "Esta supersession já estava registrada"
          : "Supersession registrada no ledger",
      );
      await loadState();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : undefined;
      if (
        code === "supersession_head_moved" ||
        code === "supersession_conflict" ||
        code === "ledger_head_contention"
      ) {
        await loadState();
      }
      setError(supersessionError(code));
    } finally {
      setSaving(false);
    }
  };

  const retract = async () => {
    if (
      saving ||
      !state?.canGovern ||
      !state.active ||
      !retractionAcknowledged
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `${supersessionUrl(artifactId)}/${encodeURIComponent(
          state.active.id,
        )}/retract`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRelationId: state.active.id,
            retractionReasonCode,
          }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        created?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "supersession_retract_failed");
      }
      setRetractionAcknowledged(false);
      notify(
        payload.created === false
          ? "A retração já estava registrada"
          : "Supersession retraída com histórico preservado",
      );
      await loadState();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : undefined;
      if (
        code === "supersession_not_active" ||
        code === "supersession_conflict" ||
        code === "ledger_head_contention"
      ) {
        await loadState();
      }
      setError(supersessionError(code));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="artifact-supersession-panel"
      aria-busy={loading || saving}
      data-testid="artifact-supersession-panel"
    >
      <header>
        <span>
          <span className="eyebrow">OUTPUT NAVIGATION · PERSISTENTE</span>
          <b>Supersession governada</b>
        </span>
        <small>metadata-only · owner/admin</small>
      </header>
      <p>
        Recomenda um replacement sem esconder outputs, alterar versões, reviews
        ou evidence de decisões.
      </p>

      {state?.active ? (
        <div className="supersession-active">
          <div className="supersession-direction">
            <span>
              <small>FONTE PINNED</small>
              <b>{state.active.source.title}</b>
              <code>v{state.active.source.pinnedVersionNumber}</code>
            </span>
            <i aria-hidden="true">→</i>
            <span>
              <small>REPLACEMENT PINNED</small>
              <b>{state.active.target.title}</b>
              <code>v{state.active.target.pinnedVersionNumber}</code>
            </span>
          </div>
          <div className="supersession-badges">
            <em>{reasonLabel(state.active.reasonCode)}</em>
            {(state.active.source.staleHead ||
              state.active.target.staleHead) && <em>HEAD AVANÇOU</em>}
            {(!state.active.source.contentAvailable ||
              !state.active.target.contentAvailable) && (
              <em>PAYLOAD INDISPONÍVEL · HASH RETIDO</em>
            )}
            {(state.active.source.projectStatus === "archived" ||
              state.active.target.projectStatus === "archived") && (
              <em>PROJETO ARQUIVADO</em>
            )}
          </div>
          <p>
            Declarado por {state.active.declaredBy.displayName}. Os pins não
            acompanham silenciosamente versões publicadas depois.
          </p>
          <a href={artifactHref(state.active.target.artifactId)}>
            Abrir replacement ↗
          </a>

          {state.canGovern && (
            <div className="supersession-retract">
              <label>
                Motivo da retração
                <select
                  value={retractionReasonCode}
                  disabled={saving}
                  onChange={(event) =>
                    setRetractionReasonCode(
                      event.target
                        .value as ArtifactSupersessionRetractionReasonCode,
                    )
                  }
                >
                  {RETRACTION_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="artifact-review-ack">
                <input
                  type="checkbox"
                  checked={retractionAcknowledged}
                  disabled={saving}
                  onChange={(event) =>
                    setRetractionAcknowledged(event.target.checked)
                  }
                />
                <span>
                  Entendo que a relação será preservada como retraída e que uma
                  nova declaração exige o target ainda live e verificável.
                </span>
              </label>
              <button
                type="button"
                className="outline-button danger-outline"
                disabled={saving || !retractionAcknowledged}
                onClick={() => void retract()}
              >
                {saving ? "Retraindo…" : "Retrair relação"}
              </button>
            </div>
          )}
        </div>
      ) : state?.canGovern ? (
        <form className="supersession-declare" onSubmit={declare}>
          <label>
            Replacement em qualquer projeto da organização
            <select
              value={targetArtifactId}
              disabled={loading || saving}
              onChange={(event) => setTargetArtifactId(event.target.value)}
            >
              {state.candidates.map((candidate) => (
                <option
                  key={candidate.artifactId}
                  value={candidate.artifactId}
                  disabled={!candidate.contentAvailable}
                >
                  {candidate.projectName} · {candidate.title} · v
                  {candidate.currentVersionNumber}
                  {candidate.contentAvailable ? "" : " · payload apagado"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Motivo padronizado
            <select
              value={reasonCode}
              disabled={loading || saving}
              onChange={(event) =>
                setReasonCode(
                  event.target.value as ArtifactSupersessionReasonCode,
                )
              }
            >
              {REASONS.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary-button compact"
            disabled={
              loading ||
              saving ||
              !selectedCandidate?.contentAvailable
            }
          >
            {saving ? "Registrando…" : "Declarar supersession"}
          </button>
        </form>
      ) : state ? (
        <div className="artifact-review-notice">
          <b>LEITURA PARA MEMBROS</b>
          <span>
            Apenas owner/admin humano pode alterar a navegação canônica.
          </span>
        </div>
      ) : null}

      {state && state.inbound.length > 0 && (
        <details className="supersession-list">
          <summary>Este output substitui · {state.inbound.length}</summary>
          {state.inbound.map((relation) => (
            <a
              key={relation.id}
              href={artifactHref(relation.source.artifactId)}
            >
              {relation.source.title} · v
              {relation.source.pinnedVersionNumber}
            </a>
          ))}
          {state.inboundTruncated && <small>Lista limitada a 100.</small>}
        </details>
      )}

      {state && state.chain.length > 1 && (
        <details className="supersession-list">
          <summary>Cadeia adiante · {state.chain.length} relações</summary>
          {state.chain.slice(1).map((relation) => (
            <a
              key={relation.id}
              href={artifactHref(relation.target.artifactId)}
            >
              → {relation.target.title} · v
              {relation.target.pinnedVersionNumber}
            </a>
          ))}
          {state.chainTruncated && (
            <small>Cadeia truncada com segurança em 100 relações.</small>
          )}
        </details>
      )}

      {state && state.history.length > 0 && (
        <details className="supersession-list">
          <summary>Histórico retraído · {state.history.length}</summary>
          {state.history.map((relation) => (
            <span key={relation.id}>
              {relation.target.title} ·{" "}
              {retractionReasonLabel(relation.retractionReasonCode)}
            </span>
          ))}
          {state.historyTruncated && <small>Histórico limitado a 100.</small>}
        </details>
      )}

      {state?.candidatesTruncated && !state.active && (
        <small className="supersession-limit">
          Mostrando os 100 outputs mais recentes da organização.
        </small>
      )}
      {error && (
        <p className="workspace-form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function reasonLabel(
  value: ArtifactSupersessionReasonCode,
): string {
  return REASONS.find((reason) => reason.value === value)?.label ?? value;
}

function retractionReasonLabel(
  value?: ArtifactSupersessionRetractionReasonCode,
): string {
  return (
    RETRACTION_REASONS.find((reason) => reason.value === value)?.label ??
    value ??
    "Sem motivo"
  );
}

function supersessionUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/supersession`;
}

function artifactHref(artifactId: string): string {
  return `?artifact=${encodeURIComponent(artifactId)}`;
}

export function supersessionError(code?: string): string {
  const messages: Record<string, string> = {
    invalid_supersession_request:
      "A solicitação contém campos ou referências inválidos.",
    invalid_supersession_reason:
      "Selecione um motivo permitido para a supersession.",
    invalid_supersession_retraction_reason:
      "Selecione um motivo permitido para a retração.",
    supersession_self_reference:
      "Um output não pode substituir a si próprio.",
    supersession_target_identical:
      "Fonte e target têm o mesmo conteúdo; a relação seria vazia.",
    supersession_head_moved:
      "Um dos heads avançou. Os dados foram atualizados; revise os pins.",
    supersession_exists:
      "Este output já possui uma supersession ativa.",
    supersession_cycle_rejected:
      "A relação criaria um ciclo entre outputs e foi bloqueada.",
    supersession_chain_too_long:
      "A cadeia excede o limite verificável e falhou fechada.",
    supersession_target_unreadable:
      "O target precisa manter payload live e íntegro.",
    artifact_payload_unavailable:
      "O payload do target falhou na verificação de integridade.",
    supersession_not_active:
      "A relação observada já não está ativa.",
    supersession_conflict:
      "Outra alteração venceu a concorrência; o estado foi atualizado.",
    ledger_head_contention:
      "Outro evento governado ocupou o ledger. Tente novamente.",
    workspace_owner_required:
      "Apenas owner/admin humano pode governar esta navegação.",
  };
  return (
    messages[code ?? ""] ??
    "Não foi possível atualizar a supersession deste output."
  );
}
