"use client";

import { useCallback, useEffect, useState } from "react";
import type { DecisionPackagePreview } from "@/src/contracts/decision-package";

type Props = {
  intentId: string;
  intentStatus: string;
  notify: (message: string) => void;
};

export function DecisionPackagePanel({
  intentId,
  intentStatus,
  notify,
}: Props) {
  const [preview, setPreview] = useState<DecisionPackagePreview | null>(null);
  const [literalPreview, setLiteralPreview] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const eligible = !["draft", "proposed"].includes(intentStatus);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!eligible) {
      setPreview(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(packageUrl(intentId), {
        cache: "no-store",
        signal,
      });
      const payload = (await response.json().catch(() => ({}))) as
        | DecisionPackagePreview
        | { error?: string };
      if (!response.ok || !("representationHash" in payload)) {
        throw new Error(
          "error" in payload
            ? payload.error
            : "decision_package_unavailable",
        );
      }
      setPreview(payload);
      setLiteralPreview("");
      setError("");
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setPreview(null);
      setError(packageError(caught));
    } finally {
      setLoading(false);
    }
  }, [eligible, intentId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void refresh(controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refresh, intentStatus]);

  const obtainMarkdown = async (mode: "preview" | "download") => {
    if (!preview || working) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch(
        packageUrl(
          intentId,
          preview.representationHash,
        ),
        { cache: "no-store" },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (payload.error === "package_changed") await refresh();
        throw new Error(payload.error ?? "decision_package_unavailable");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const calculated = await sha256Hex(bytes);
      if (calculated !== preview.representationHash) {
        throw new Error("decision_package_hash_mismatch");
      }
      if (mode === "preview") {
        setLiteralPreview(new TextDecoder().decode(bytes));
        notify("Preview literal verificado byte a byte");
      } else {
        downloadBytes(
          bytes,
          response.headers.get("content-disposition"),
          intentId,
        );
        notify("Decision package Markdown verificado e baixado");
      }
    } catch (caught) {
      setError(packageError(caught));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section
      className="decision-package-panel"
      aria-busy={loading || working}
      data-testid="decision-package-panel"
    >
      <header>
        <span>
          <small>DECISION PACKAGE · REAL · S5.B5</small>
          <b>Decisão exportável e verificável</b>
        </span>
        <em>read-only · owner/admin</em>
      </header>
      <p>
        Reúne decisão, produtor, evidências exatas, reviews, supersession e
        referências do ledger sem persistir outra cópia do payload.
      </p>

      {!eligible ? (
        <div className="decision-package-locked">
          <b>EVIDENCE SET OPEN</b>
          <span>
            O pacote só existe depois que o intent deixa draft/proposed.
          </span>
        </div>
      ) : preview ? (
        <>
          <div className="decision-package-metrics">
            <span>
              <small>EVIDENCE</small>
              <b>{preview.evidence.length}</b>
            </span>
            <span>
              <small>REVIEWS</small>
              <b>{preview.reviews}</b>
            </span>
            <span>
              <small>LEDGER REFS</small>
              <b>
                {preview.ledgerEntries}/{preview.ledgerEntriesTotal}
              </b>
            </span>
            <span>
              <small>MARKDOWN</small>
              <b>{formatBytes(preview.byteSize)}</b>
            </span>
          </div>
          <div className="decision-package-hash">
            <span>
              <small>SHA-256 DOS BYTES EXATOS</small>
              <code>{preview.representationHash}</code>
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                void navigator.clipboard.writeText(
                  preview.representationHash,
                );
                notify("SHA-256 copiado");
              }}
            >
              Copiar hash
            </button>
          </div>
          <div className="decision-package-disclosures">
            <em>
              {preview.ledgerEntries > 0 &&
              preview.ledgerEntryHashesValid
                ? "ENTRY HASHES RECOMPUTED"
                : preview.ledgerEntries > 0
                  ? "LEDGER ENTRY HASH FAILED"
                  : "NO LEDGER ENTRIES INCLUDED"}
            </em>
            {preview.erasedBodies > 0 && (
              <em>{preview.erasedBodies} PAYLOAD ERASED</em>
            )}
            {preview.failedBodies > 0 && (
              <em>{preview.failedBodies} INTEGRITY FAILED</em>
            )}
            {preview.omittedBodies > 0 && (
              <em>{preview.omittedBodies} BODY OMITTED BY SIZE</em>
            )}
            {(preview.supersessionsTruncated ||
              preview.ledgerEntriesTruncated ||
              preview.evidence.some((item) => item.reviewsTruncated)) && (
              <em>ADVISORY WINDOW TRUNCATED</em>
            )}
          </div>
          <p className="decision-package-limit">
            O subset do ledger não prova continuidade, preimages, registro do
            artifact ou assinatura. Exportar move os bytes para fora da
            retenção do NexusOS.
          </p>
          <div className="decision-package-actions">
            <button
              type="button"
              className="outline-button"
              disabled={working}
              onClick={() => void obtainMarkdown("preview")}
            >
              {working ? "Verificando…" : "Preview literal"}
            </button>
            <button
              type="button"
              className="primary-button compact"
              disabled={working}
              onClick={() => void obtainMarkdown("download")}
            >
              Baixar .md verificado
            </button>
          </div>
          {literalPreview && (
            <details className="decision-package-literal" open>
              <summary>Markdown literal · não executado</summary>
              <pre>{literalPreview}</pre>
            </details>
          )}
        </>
      ) : loading ? (
        <div className="decision-package-loading">Gerando projeção exata…</div>
      ) : null}
      {error && (
        <p className="live-spine-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function packageUrl(intentId: string, expectedHash?: string): string {
  const params = new URLSearchParams();
  if (expectedHash) {
    params.set("format", "markdown");
    params.set("expectedRepresentationHash", expectedHash);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return `/api/governance/intents/${encodeURIComponent(
    intentId,
  )}/decision-package${query}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      bytes.slice().buffer as ArrayBuffer,
    ),
  );
  return Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function downloadBytes(
  bytes: Uint8Array,
  contentDisposition: string | null,
  intentId: string,
): void {
  const encoded = bytes.slice().buffer as ArrayBuffer;
  const url = URL.createObjectURL(
    new Blob([encoded], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download =
    contentDisposition?.match(/filename="([^"]+)"/)?.[1] ??
    `decision-package-${intentId}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function packageError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const copy: Record<string, string> = {
    workspace_owner_required:
      "Apenas owner/admin humano pode exportar o pacote completo.",
    decision_not_reached:
      "O intent ainda não atingiu uma decisão exportável.",
    package_bounds_exceeded:
      "A evidência crítica excede o limite completo do pacote.",
    decision_package_graph_inconsistent:
      "A linhagem imutável está inconsistente; o pacote falhou fechado.",
    package_changed:
      "Fatos incluídos mudaram desde o preview. O hash foi atualizado.",
    decision_package_hash_mismatch:
      "Os bytes recebidos não correspondem ao SHA-256 apresentado.",
  };
  return copy[code] ?? "Decision package indisponível.";
}

function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : `${(value / 1024).toFixed(1)} KiB`;
}
