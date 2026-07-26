"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  IntentArtifactEvidence,
  IntentEvidenceCandidate,
} from "@/src/contracts/governance";

type EvidenceState = {
  intentId: string;
  intentStatus: string;
  frozen: boolean;
  evidence: IntentArtifactEvidence[];
  candidates: IntentEvidenceCandidate[];
  candidatesTruncated: boolean;
};

type Props = {
  intentId: string;
  intentStatus: string;
  onOpenArtifact: (artifactId: string) => void;
  onLedgerChanged: () => void;
  notify: (message: string) => void;
};

export function IntentEvidencePanel({
  intentId,
  intentStatus,
  onOpenArtifact,
  onLedgerChanged,
  notify,
}: Props) {
  const [state, setState] = useState<EvidenceState | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(
      `/api/governance/intents/${intentId}/evidence`,
      { cache: "no-store", signal },
    );
    if (!response.ok) throw new Error("evidence_unavailable");
    const next = (await response.json()) as EvidenceState;
    setState(next);
    setSelectedVersionId((current) =>
      next.candidates.some(
        (candidate) =>
          candidate.artifactVersionId === current && !candidate.erasedAt,
      )
        ? current
        : next.candidates.find((candidate) => !candidate.erasedAt)
            ?.artifactVersionId ?? "",
    );
    setError("");
  }, [intentId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void refresh(controller.signal).catch((refreshError: unknown) => {
        if (
          !(refreshError instanceof Error) ||
          refreshError.name !== "AbortError"
        ) {
          setError("Evidências indisponíveis para este intent.");
        }
      });
    }, 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [intentStatus, refresh]);

  const linkedActiveVersionIds = useMemo(
    () =>
      new Set(
        state?.evidence
          .filter((evidence) => evidence.status === "active")
          .map((evidence) => evidence.artifactVersionId) ?? [],
      ),
    [state],
  );
  const candidates =
    state?.candidates.filter(
      (candidate) =>
        !candidate.erasedAt &&
        !linkedActiveVersionIds.has(candidate.artifactVersionId),
    ) ?? [];
  const selectedCandidate =
    candidates.find(
      (candidate) => candidate.artifactVersionId === selectedVersionId,
    ) ?? candidates[0];

  const attach = async () => {
    if (!selectedCandidate) return;
    setPending(true);
    try {
      const response = await fetch(
        `/api/governance/intents/${intentId}/evidence`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            artifactVersionId: selectedCandidate.artifactVersionId,
            relation: "basis",
          }),
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      await refresh();
      onLedgerChanged();
      notify("Versão imutável vinculada como base da decisão");
    } catch (attachError) {
      setError(evidenceErrorCopy(attachError));
    } finally {
      setPending(false);
    }
  };

  const supersede = async (evidenceId: string) => {
    setPending(true);
    try {
      const response = await fetch(
        `/api/governance/intents/${intentId}/evidence/${evidenceId}/supersede`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await readError(response));
      await refresh();
      onLedgerChanged();
      notify("Vínculo superseded; histórico preservado no ledger");
    } catch (supersedeError) {
      setError(evidenceErrorCopy(supersedeError));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="intent-evidence" aria-label="Evidências do intent">
      <header>
        <div>
          <small>EVIDENCE LINEAGE · REAL</small>
          <b>Versões que fundamentam a decisão</b>
        </div>
        <span className={state?.frozen ? "is-frozen" : ""}>
          {state?.frozen ? "Frozen at decision" : "Open evidence set"}
        </span>
      </header>
      <p>
        Apenas IDs, hash e metadados imutáveis entram na governança. O conteúdo
        permanece no artifact e pode ser apagado pela política de retenção.
        Uma versão histórica pode ser citada intencionalmente.
      </p>
      {!state?.frozen && (
        <div className="intent-evidence-attach">
          <select
            aria-label="Versão de artifact para evidência"
            value={selectedCandidate?.artifactVersionId ?? ""}
            disabled={pending || candidates.length === 0}
            onChange={(event) => setSelectedVersionId(event.target.value)}
          >
            {candidates.length === 0 ? (
              <option value="">
                {state?.candidatesTruncated
                  ? "Nenhuma elegível entre as 100 mais recentes"
                  : "Nenhuma versão elegível"}
              </option>
            ) : (
              candidates.map((candidate) => (
                <option
                  key={candidate.artifactVersionId}
                  value={candidate.artifactVersionId}
                >
                  {candidate.workItemRef} · {candidate.artifactTitle} · v
                  {candidate.versionNumber}
                </option>
              ))
            )}
          </select>
          <button
            className="outline-button"
            disabled={pending || !selectedCandidate}
            onClick={attach}
          >
            + Vincular basis
          </button>
        </div>
      )}
      {state?.candidatesTruncated && !state.frozen && (
        <small className="intent-evidence-cap">
          Mostrando as 100 versões mais recentes do projeto. Versões anteriores
          continuam preservadas e exigem busca/paginação futura.
        </small>
      )}
      <div className="intent-evidence-list">
        {state?.evidence.length ? (
          state.evidence.map((evidence) => (
            <article
              key={evidence.id}
              className={evidence.status === "superseded" ? "is-muted" : ""}
            >
              <button
                className="intent-evidence-link"
                onClick={() => onOpenArtifact(evidence.artifactId)}
              >
                <span>{evidence.workItemRef}</span>
                <b>{evidence.artifactTitle}</b>
                <small>v{evidence.versionNumber} · {evidence.relation}</small>
              </button>
              <code>sha256:{evidence.contentHash.slice(0, 16)}…</code>
              <span className="intent-evidence-state">
                {evidence.erasedAt
                  ? "Payload apagado · prova preservada"
                  : evidence.status}
              </span>
              {!state.frozen && evidence.status === "active" && (
                <button
                  className="text-button"
                  disabled={pending}
                  onClick={() => supersede(evidence.id)}
                >
                  Supersede
                </button>
              )}
            </article>
          ))
        ) : (
          <div className="intent-evidence-empty">
            Nenhuma evidência vinculada a este intent.
          </div>
        )}
      </div>
      {error && <p className="live-spine-error" role="alert">{error}</p>}
    </section>
  );
}

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return payload.error ?? "evidence_operation_failed";
}

function evidenceErrorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "evidence_set_frozen") {
    return "A decisão já avançou; seu conjunto de evidências está congelado.";
  }
  if (code === "evidence_already_linked") {
    return "Esta versão já está vinculada como evidência ativa.";
  }
  if (code === "conflict_retry") {
    return "Outra gravação entrou no ledger ao mesmo tempo. Tente novamente.";
  }
  if (code === "artifact_payload_erased") {
    return "O payload desta versão já foi apagado e não pode entrar como nova base.";
  }
  return "Não foi possível atualizar as evidências agora.";
}
