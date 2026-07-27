"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunnerAdmissionPolicyResponse } from "@/src/contracts/runners";
import {
  AdmissionPolicyView,
  mergeRunnerAdmissionPolicyResponse,
  readRunnerAdmissionPolicyResponse,
} from "./admission-policy-view";

type PolicyLoadError = {
  message: string;
  retryable: boolean;
};

export function RunnerAdmissionPolicyPanel() {
  const [response, setResponse] =
    useState<RunnerAdmissionPolicyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<PolicyLoadError | null>(
    null,
  );
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const terminalErrorRef = useRef(false);

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
      if (!terminalErrorRef.current) void loadPolicy(true);
    }, 20_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      requestIdRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [loadPolicy]);

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
      className="runner-policy-panel"
      aria-label="Política de admissão de runners"
      aria-busy={loading}
    >
      {loading && !response && (
        <div className="runner-policy-loading">
          <span aria-hidden="true">◌</span>
          <p>Consultando a decisão humana de admissão…</p>
        </div>
      )}
      {response && <AdmissionPolicyView response={response} />}
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

function policyErrorCode(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

function policyLoadFailure(
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
