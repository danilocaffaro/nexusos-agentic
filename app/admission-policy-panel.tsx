"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  RunnerAdmissionPolicy,
  RunnerAdmissionPolicyResponse,
} from "@/src/contracts/runners";
import {
  AdmissionPolicyView,
  mergeRunnerAdmissionPolicyResponse,
  readRunnerAdmissionPolicyResponse,
} from "./admission-policy-view";
import {
  AdmissionPolicyEditor,
  policyDraftFrom,
  policyDraftPutInput,
  rebasePolicyDraft,
  type AdmissionPolicyDraft,
} from "./admission-policy-editor";

type PolicyLoadError = {
  message: string;
  retryable: boolean;
};

export function RunnerAdmissionPolicyPanel({
  onPolicyCommitted,
  notify,
}: {
  onPolicyCommitted?: (policy: RunnerAdmissionPolicy) => void;
  notify?: (message: string) => void;
}) {
  const [response, setResponse] =
    useState<RunnerAdmissionPolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<PolicyLoadError | null>(
    null,
  );
  const [draft, setDraft] = useState<AdmissionPolicyDraft | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const terminalErrorRef = useRef(false);
  const editorOpenRef = useRef(false);
  const mutationIdRef = useRef(0);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const loadPolicy = useCallback(async (quiet = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!quiet) setLoading(true);
    try {
      const httpResponse = await fetch("/api/runner-admission-policy", {
        cache: "no-store",
        signal: controller.signal,
      });
      const value: unknown = await httpResponse.json().catch(() => null);
      if (!httpResponse.ok) {
        throw policyLoadFailure(
          httpResponse.status,
          policyErrorCode(value),
        );
      }
      const parsed = readRunnerAdmissionPolicyResponse(value);
      if (!parsed) throw policyLoadFailure(502, "policy_invalid");
      if (requestId !== requestIdRef.current) return;
      setResponse((current) =>
        mergeRunnerAdmissionPolicyResponse(current, parsed),
      );
      terminalErrorRef.current = false;
      setLoadError(null);
    } catch (caught) {
      if (
        controller.signal.aborted ||
        requestId !== requestIdRef.current
      ) {
        return;
      }
      const failure = isPolicyLoadError(caught)
        ? caught
        : policyLoadFailure(0, "network_error");
      terminalErrorRef.current = !failure.retryable;
      setLoadError(failure);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void loadPolicy();
    }, 0);
    const timer = window.setInterval(() => {
      if (
        !terminalErrorRef.current &&
        !editorOpenRef.current
      ) {
        void loadPolicy(true);
      }
    }, 20_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      requestIdRef.current += 1;
      controllerRef.current?.abort();
      mutationIdRef.current += 1;
      mutationControllerRef.current?.abort();
    };
  }, [loadPolicy]);

  const openEditor = () => {
    if (!response?.viewerCanEditPolicy || loadError) return;
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    editorOpenRef.current = true;
    setLoading(false);
    setDraft(policyDraftFrom(response.policy));
    setSubmitting(false);
  };

  const closeEditor = () => {
    mutationIdRef.current += 1;
    mutationControllerRef.current?.abort();
    editorOpenRef.current = false;
    setDraft(null);
    setSubmitting(false);
    window.setTimeout(
      () => (editButtonRef.current ?? panelRef.current)?.focus(),
      0,
    );
  };

  const submitDraft = async () => {
    if (!draft || submitting || draft.permissionLost) return;
    const submissionDraft = rebasePolicyDraft(draft);
    if (submissionDraft !== draft) setDraft(submissionDraft);
    const validated = policyDraftPutInput(submissionDraft);
    if (!validated.ok) {
      setDraft({
        ...submissionDraft,
        submitError: validated.message,
      });
      return;
    }

    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    const mutationId = mutationIdRef.current + 1;
    mutationIdRef.current = mutationId;
    setSubmitting(true);
    setDraft({ ...submissionDraft, submitError: "" });
    try {
      const httpResponse = await fetch(
        "/api/runner-admission-policy",
        {
          method: "PUT",
          cache: "no-store",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validated.input),
        },
      );
      const value: unknown = await httpResponse.json().catch(() => null);
      if (mutationId !== mutationIdRef.current) return;
      if (httpResponse.ok) {
        const parsed = readRunnerAdmissionPolicyResponse(value);
        if (
          !parsed ||
          parsed.policy.source !== "configured" ||
          parsed.policy.version !== validated.input.expectedVersion + 1
        ) {
          throw policyMutationFailure("policy_invalid");
        }
        setResponse((current) =>
          mergeRunnerAdmissionPolicyResponse(current, parsed),
        );
        editorOpenRef.current = false;
        setDraft(null);
        onPolicyCommitted?.(parsed.policy);
        notify?.(`Política v${parsed.policy.version} gravada no Decision Ledger`);
        window.setTimeout(() => editButtonRef.current?.focus(), 0);
        return;
      }

      const code = policyErrorCode(value);
      if (httpResponse.status === 409 && code === "policy_version_conflict") {
        await refreshFactsAfterConflict({
          controller,
          mutationId,
          submissionDraft,
        });
        return;
      }
      if (
        httpResponse.status === 403 ||
        code === "workspace_owner_required"
      ) {
        await refreshFactsAfterPermissionLoss({
          controller,
          mutationId,
          submissionDraft,
        });
        return;
      }
      throw policyMutationFailure(code ?? "policy_write_failed");
    } catch (caught) {
      if (
        controller.signal.aborted ||
        mutationId !== mutationIdRef.current
      ) {
        return;
      }
      const code =
        caught instanceof Error ? caught.message : "policy_write_failed";
      if (isAmbiguousPolicyMutation(code)) {
        await refreshFactsAfterAmbiguousResult({
          controller,
          mutationId,
          submissionDraft,
        });
        return;
      }
      setDraft((current) =>
        current
          ? { ...current, submitError: policyMutationMessage(code) }
          : current,
      );
    } finally {
      if (mutationId === mutationIdRef.current) setSubmitting(false);
    }
  };

  const refreshFactsAfterConflict = async ({
    controller,
    mutationId,
    submissionDraft,
  }: {
    controller: AbortController;
    mutationId: number;
    submissionDraft: AdmissionPolicyDraft;
  }) => {
    try {
      const httpResponse = await fetch("/api/runner-admission-policy", {
        cache: "no-store",
        signal: controller.signal,
      });
      const value: unknown = await httpResponse.json().catch(() => null);
      const code = policyErrorCode(value);
      if (
        httpResponse.status === 403 ||
        code === "workspace_membership_required"
      ) {
        if (mutationId !== mutationIdRef.current) return;
        setResponse((current) =>
          current
            ? { ...current, viewerCanEditPolicy: false }
            : current,
        );
        setDraft({
          ...submissionDraft,
          permissionLost: true,
          submitError:
            "Sua permissão de acesso mudou durante o conflito. O rascunho foi mantido somente para consulta.",
        });
        return;
      }
      if (!httpResponse.ok) {
        throw policyMutationFailure("conflict_refresh_failed");
      }
      const parsed = readRunnerAdmissionPolicyResponse(value);
      if (
        !parsed ||
        parsed.policy.version <= submissionDraft.baseVersion
      ) {
        throw policyMutationFailure("conflict_refresh_failed");
      }
      if (mutationId !== mutationIdRef.current) return;
      setResponse((current) =>
        mergeRunnerAdmissionPolicyResponse(current, parsed),
      );
      if (!parsed.viewerCanEditPolicy) {
        setDraft({
          ...submissionDraft,
          permissionLost: true,
          submitError:
            "Sua permissão de edição foi removida durante o conflito. O rascunho foi mantido somente para consulta.",
        });
        return;
      }
      setDraft({
        ...submissionDraft,
        conflict: { serverVersion: parsed.policy.version },
        submitError: "",
      });
    } catch (caught) {
      if (
        controller.signal.aborted ||
        mutationId !== mutationIdRef.current
      ) {
        return;
      }
      setDraft({
        ...submissionDraft,
        submitError: policyMutationMessage(
          caught instanceof Error
            ? caught.message
            : "conflict_refresh_failed",
        ),
      });
    }
  };

  const refreshFactsAfterPermissionLoss = async ({
    controller,
    mutationId,
    submissionDraft,
  }: {
    controller: AbortController;
    mutationId: number;
    submissionDraft: AdmissionPolicyDraft;
  }) => {
    let refreshed = false;
    try {
      const httpResponse = await fetch("/api/runner-admission-policy", {
        cache: "no-store",
        signal: controller.signal,
      });
      const value: unknown = await httpResponse.json().catch(() => null);
      const parsed = httpResponse.ok
        ? readRunnerAdmissionPolicyResponse(value)
        : null;
      if (
        controller.signal.aborted ||
        mutationId !== mutationIdRef.current
      ) {
        return;
      }
      if (parsed) {
        setResponse((current) => {
          const merged = mergeRunnerAdmissionPolicyResponse(current, {
            ...parsed,
            viewerCanEditPolicy: false,
          });
          return { ...merged, viewerCanEditPolicy: false };
        });
        refreshed = true;
      } else {
        setResponse((current) =>
          current
            ? { ...current, viewerCanEditPolicy: false }
            : current,
        );
      }
    } catch {
      if (
        controller.signal.aborted ||
        mutationId !== mutationIdRef.current
      ) {
        return;
      }
      setResponse((current) =>
        current
          ? { ...current, viewerCanEditPolicy: false }
          : current,
      );
    }
    setDraft({
      ...submissionDraft,
      permissionLost: true,
      submitError: refreshed
        ? "Sua permissão de edição foi removida. Os fatos atuais foram recarregados e seu rascunho foi mantido somente para consulta."
        : "Sua permissão de edição foi removida. Não foi possível atualizar os fatos; seu rascunho foi mantido somente para consulta.",
    });
  };

  const refreshFactsAfterAmbiguousResult = async ({
    controller,
    mutationId,
    submissionDraft,
  }: {
    controller: AbortController;
    mutationId: number;
    submissionDraft: AdmissionPolicyDraft;
  }) => {
    try {
      const httpResponse = await fetch("/api/runner-admission-policy", {
        cache: "no-store",
        signal: controller.signal,
      });
      const value: unknown = await httpResponse.json().catch(() => null);
      const code = policyErrorCode(value);
      if (
        httpResponse.status === 403 ||
        code === "workspace_membership_required"
      ) {
        if (mutationId !== mutationIdRef.current) return;
        setResponse((current) =>
          current
            ? { ...current, viewerCanEditPolicy: false }
            : current,
        );
        setDraft({
          ...submissionDraft,
          permissionLost: true,
          submitError:
            "O servidor não confirmou o resultado da gravação e seu acesso mudou. O rascunho foi mantido somente para consulta.",
        });
        return;
      }
      if (!httpResponse.ok) {
        throw policyMutationFailure("ambiguous_refresh_failed");
      }
      const parsed = readRunnerAdmissionPolicyResponse(value);
      if (
        !parsed ||
        parsed.policy.version < submissionDraft.baseVersion
      ) {
        throw policyMutationFailure("ambiguous_refresh_failed");
      }
      if (mutationId !== mutationIdRef.current) return;
      setResponse((current) =>
        mergeRunnerAdmissionPolicyResponse(current, parsed),
      );
      if (!parsed.viewerCanEditPolicy) {
        setDraft({
          ...submissionDraft,
          permissionLost: true,
          submitError:
            "O servidor não confirmou o resultado da gravação. Os fatos atuais foram recarregados, sua permissão mudou e o rascunho foi mantido somente para consulta.",
        });
        return;
      }
      const advanced =
        parsed.policy.version > submissionDraft.baseVersion;
      setDraft({
        ...submissionDraft,
        conflict: advanced
          ? { serverVersion: parsed.policy.version }
          : null,
        submitError: advanced
          ? `O servidor não confirmou a resposta da gravação, mas os fatos atuais avançaram para a v${parsed.policy.version}. Revise-os antes de decidir por um reenvio explícito.`
          : `O servidor não confirmou o resultado da gravação. Os fatos atuais ainda mostram a v${parsed.policy.version}; revise-os antes de decidir por uma nova tentativa.`,
      });
    } catch {
      if (
        controller.signal.aborted ||
        mutationId !== mutationIdRef.current
      ) {
        return;
      }
      setDraft({
        ...submissionDraft,
        submitError:
          "O servidor não confirmou o resultado da gravação e os fatos atuais não puderam ser recarregados. O rascunho foi preservado; aguarde antes de decidir por uma nova tentativa.",
      });
    }
  };

  const statusMessage = loading
    ? "Consultando política de admissão."
    : loadError
      ? ""
      : response
        ? response.policy.source === "default"
          ? "Padrão virtual de admissão carregado."
          : `Política configurada versão ${response.policy.version} carregada.`
        : "";

  return (
    <section
      ref={panelRef}
      className="runner-policy-panel"
      aria-label="Política de admissão de runners"
      aria-busy={loading}
      tabIndex={-1}
    >
      {loading && !response && (
        <div className="runner-policy-loading">
          <span aria-hidden="true">◌</span>
          <p>Consultando a decisão humana de admissão…</p>
        </div>
      )}
      {response && <AdmissionPolicyView response={response} />}
      {response?.viewerCanEditPolicy && !draft && (
        <div className="runner-policy-toolbar">
          <button
            ref={editButtonRef}
            type="button"
            className="outline-button compact"
            aria-expanded="false"
            aria-controls="runner-policy-editor"
            disabled={!!loadError}
            onClick={openEditor}
          >
            Editar política
          </button>
        </div>
      )}
      {draft && (
        <AdmissionPolicyEditor
          draft={draft}
          submitting={submitting}
          onChange={setDraft}
          onCancel={closeEditor}
          onSubmit={() => void submitDraft()}
        />
      )}
      {loading && response && (
        <p className="runner-policy-refreshing">
          Atualizando política de admissão…
        </p>
      )}
      {loadError && (
        <div className="runner-policy-error" role="alert">
          <p>{loadError.message}</p>
          {loadError.retryable && (
            <button type="button" onClick={() => void loadPolicy()}>
              Tentar novamente
            </button>
          )}
        </div>
      )}
      <p
        className="sr-only runner-policy-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {statusMessage}
      </p>
    </section>
  );
}

function policyMutationFailure(code: string) {
  return new Error(code);
}

export function policyMutationMessage(code: string) {
  if (code === "invalid_admission_policy") {
    return "Valores fora dos limites do servidor. Ajuste o rascunho e reenvie.";
  }
  if (code === "authentication_required") {
    return "Sua sessão precisa ser renovada. O rascunho foi preservado.";
  }
  if (code === "conflict_refresh_failed") {
    return "O conflito foi detectado, mas os fatos atuais não puderam ser carregados. O rascunho foi preservado; feche e reabra a edição antes de decidir por um reenvio.";
  }
  if (code === "policy_invalid") {
    return "A confirmação do servidor não corresponde ao contrato desta versão. O resultado desta gravação não foi confirmado na tela.";
  }
  return "O servidor não confirmou o resultado desta gravação. A política pode já ter sido alterada; recarregue os fatos antes de decidir por um reenvio.";
}

export function isAmbiguousPolicyMutation(code: string) {
  return ![
    "invalid_admission_policy",
    "authentication_required",
    "conflict_refresh_failed",
  ].includes(code);
}

function policyErrorCode(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

export function policyLoadFailure(
  status: number,
  code: string | null,
): PolicyLoadError {
  if (status === 401 || code === "authentication_required") {
    return {
      message: "Sua sessão precisa ser renovada.",
      retryable: false,
    };
  }
  if (
    status === 403 ||
    code === "workspace_membership_required"
  ) {
    return {
      message: "Você não possui mais acesso a esta política.",
      retryable: false,
    };
  }
  if (code === "policy_invalid") {
    return {
      message:
        "A resposta da política não corresponde ao contrato desta versão.",
      retryable: false,
    };
  }
  return {
    message: "Não foi possível consultar a política de admissão.",
    retryable: true,
  };
}

function isPolicyLoadError(value: unknown): value is PolicyLoadError {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Partial<PolicyLoadError>).message === "string" &&
    typeof (value as Partial<PolicyLoadError>).retryable === "boolean"
  );
}
