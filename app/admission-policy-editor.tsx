"use client";

import { useEffect, useRef } from "react";
import type {
  RunnerAdmissionPolicy,
  RunnerCapabilityName,
} from "@/src/contracts/runners";
import { POLICY_CAPABILITIES } from "./admission-policy-view";

export type AdmissionPolicyDraft = {
  baseVersion: number;
  freshnessInput: string;
  allowedCapabilities: RunnerCapabilityName[];
  conflict: { serverVersion: number } | null;
  submitError: string;
  permissionLost: boolean;
};

export type AdmissionPolicyPutInput = {
  expectedVersion: number;
  capabilityFreshnessSeconds: number;
  allowedCapabilities: RunnerCapabilityName[];
};

export function AdmissionPolicyEditor({
  draft,
  submitting,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: AdmissionPolicyDraft;
  submitting: boolean;
  onChange: (draft: AdmissionPolicyDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const alertRef = useRef<HTMLDivElement>(null);
  const freshnessRef = useRef<HTMLInputElement>(null);
  const alertKey = `${draft.conflict?.serverVersion ?? ""}:${draft.submitError}:${draft.permissionLost}`;

  useEffect(() => {
    freshnessRef.current?.focus();
  }, []);

  useEffect(() => {
    if (alertKey !== "::false") alertRef.current?.focus();
  }, [alertKey]);

  const allowed = new Set(draft.allowedCapabilities);
  return (
    <form
      className="runner-policy-editor"
      id="runner-policy-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting && !draft.permissionLost) onSubmit();
      }}
    >
      <header>
        <div>
          <span>DECISÃO GOVERNADA · COMPARE-AND-SWAP</span>
          <h3>Editar política de admissão</h3>
        </div>
        <strong>BASE CONGELADA · v{draft.baseVersion}</strong>
      </header>

      {(draft.conflict || draft.submitError) && (
        <div
          className="runner-policy-editor-alert"
          ref={alertRef}
          tabIndex={-1}
          role="alert"
        >
          {draft.conflict && (
            <p>
              A política avançou para a v{draft.conflict.serverVersion} desde
              a abertura deste rascunho. Seu rascunho foi preservado; revise os
              fatos atualizados e reenvie explicitamente.
            </p>
          )}
          {draft.submitError && <p>{draft.submitError}</p>}
        </div>
      )}

      <label
        className="runner-policy-freshness-field"
        htmlFor="runner-policy-freshness"
      >
        <span>Janela declarativa em segundos</span>
        <input
          id="runner-policy-freshness"
          ref={freshnessRef}
          name="capabilityFreshnessSeconds"
          type="number"
          min={3_600}
          max={2_592_000}
          step={1}
          inputMode="numeric"
          value={draft.freshnessInput}
          disabled={submitting || draft.permissionLost}
          aria-describedby="runner-policy-freshness-help"
          onChange={(event) =>
            onChange({
              ...draft,
              freshnessInput: event.target.value,
              submitError: "",
            })
          }
        />
        <small id="runner-policy-freshness-help">
          1h = 3600 · 24h = 86400 · 30d = 2592000
        </small>
      </label>

      <fieldset disabled={submitting || draft.permissionLost}>
        <legend>Capacidades permitidas quando exigidas no diagnóstico</legend>
        <div className="runner-policy-editor-capabilities">
          {POLICY_CAPABILITIES.map((capability) => (
            <label key={capability}>
              <input
                type="checkbox"
                name="allowedCapabilities"
                value={capability}
                checked={allowed.has(capability)}
                onChange={() =>
                  onChange(togglePolicyCapability(draft, capability))
                }
              />
              <span>{policyEditorCapabilityLabel(capability)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {draft.allowedCapabilities.length === 0 && (
        <p className="runner-policy-deny-warning">
          <b>DENY-ALL EXPLÍCITO</b>
          Nenhuma capacidade exigida poderá satisfazer a cláusula declarativa.
          Atribuições sem capacidade exigida continuam independentes.
        </p>
      )}

      {draft.permissionLost && (
        <p className="runner-policy-permission-lost">
          O rascunho está somente leitura para consulta. Feche a edição quando
          terminar de copiar os valores necessários.
        </p>
      )}

      <footer>
        <button
          type="button"
          className="outline-button compact"
          onClick={onCancel}
        >
          {draft.permissionLost ? "Fechar edição" : "Cancelar"}
        </button>
        {!draft.permissionLost && (
          <button
            type="submit"
            className="primary-button compact"
            disabled={submitting}
          >
            {submitting
              ? "Gravando decisão…"
              : draft.conflict
                ? `Reenviar sobre a v${draft.conflict.serverVersion}`
                : `Salvar sobre a v${draft.baseVersion}`}
          </button>
        )}
      </footer>
    </form>
  );
}

export function policyDraftFrom(
  policy: RunnerAdmissionPolicy,
): AdmissionPolicyDraft {
  return {
    baseVersion: policy.version,
    freshnessInput: String(policy.capabilityFreshnessSeconds),
    allowedCapabilities: POLICY_CAPABILITIES.filter((capability) =>
      policy.allowedCapabilities.includes(capability),
    ),
    conflict: null,
    submitError: "",
    permissionLost: false,
  };
}

export function togglePolicyCapability(
  draft: AdmissionPolicyDraft,
  capability: RunnerCapabilityName,
): AdmissionPolicyDraft {
  const selected = new Set(draft.allowedCapabilities);
  if (selected.has(capability)) selected.delete(capability);
  else selected.add(capability);
  return {
    ...draft,
    allowedCapabilities: POLICY_CAPABILITIES.filter((item) =>
      selected.has(item),
    ),
    submitError: "",
  };
}

export function rebasePolicyDraft(
  draft: AdmissionPolicyDraft,
): AdmissionPolicyDraft {
  return draft.conflict
    ? {
        ...draft,
        baseVersion: draft.conflict.serverVersion,
        conflict: null,
        submitError: "",
      }
    : draft;
}

export function policyDraftPutInput(
  draft: AdmissionPolicyDraft,
):
  | { ok: true; input: AdmissionPolicyPutInput }
  | { ok: false; message: string } {
  const capabilityFreshnessSeconds = Number(draft.freshnessInput);
  if (
    !Number.isSafeInteger(capabilityFreshnessSeconds) ||
    capabilityFreshnessSeconds < 3_600 ||
    capabilityFreshnessSeconds > 2_592_000
  ) {
    return {
      ok: false,
      message:
        "Informe uma janela inteira entre 3600 segundos (1h) e 2592000 segundos (30d).",
    };
  }
  const unique = new Set(draft.allowedCapabilities);
  if (
    unique.size !== draft.allowedCapabilities.length ||
    !draft.allowedCapabilities.every((capability) =>
      POLICY_CAPABILITIES.includes(capability),
    )
  ) {
    return {
      ok: false,
      message: "O rascunho contém uma capacidade fora do conjunto fechado.",
    };
  }
  return {
    ok: true,
    input: {
      expectedVersion: draft.baseVersion,
      capabilityFreshnessSeconds,
      allowedCapabilities: POLICY_CAPABILITIES.filter((capability) =>
        unique.has(capability),
      ),
    },
  };
}

function policyEditorCapabilityLabel(value: RunnerCapabilityName) {
  return {
    node_permission_model: "Node Permission Model",
    bubblewrap: "Bubblewrap",
    landlock: "Landlock",
    seccomp: "Seccomp",
    user_namespace: "User namespace",
    docker: "Docker",
    podman: "Podman",
  }[value];
}
