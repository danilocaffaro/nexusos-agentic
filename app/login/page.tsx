"use client";

import { FormEvent, useEffect, useState } from "react";

type AuthStatus = {
  mode: "remote";
  activationRequired: boolean;
  authenticated: boolean;
};

export default function LoginPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [login, setLogin] = useState("owner");
  const [displayName, setDisplayName] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/status", { cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => ({}));
        if (!response.ok || !isAuthStatus(payload)) {
          throw new Error("remote_auth_unavailable");
        }
        if (payload.authenticated) {
          window.location.replace("/");
          return;
        }
        if (active) setStatus(payload);
      })
      .catch(() => {
        if (active) {
          setError(
            "O acesso remoto não está configurado corretamente neste servidor.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!status || submitting) return;
    if (passphrase.length < 16) {
      setError("Use uma frase-senha com pelo menos 16 caracteres.");
      return;
    }
    if (status.activationRequired && passphrase !== confirmation) {
      setError("A confirmação da frase-senha não coincide.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(
        status.activationRequired
          ? "/api/auth/activate"
          : "/api/auth/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            status.activationRequired
              ? { login, displayName, bootstrapToken, passphrase }
              : { login, passphrase },
          ),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "auth_failed");
      window.location.replace("/");
    } catch (reason) {
      setError(authErrorMessage(reason));
      setSubmitting(false);
    }
  };

  return (
    <main className="remote-auth-shell">
      <section className="remote-auth-card">
        <header>
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <b>NexusOS</b>
            <small>Remote access</small>
          </span>
        </header>
        <div className="remote-auth-heading">
          <span className="eyebrow">
            {status?.activationRequired
              ? "ATIVAÇÃO SEGURA"
              : "SESSÃO AUTENTICADA"}
          </span>
          <h1>
            {status?.activationRequired
              ? "Proteja este NexusOS antes do primeiro acesso."
              : "Entre no seu operating fabric."}
          </h1>
          <p>
            {status?.activationRequired
              ? "O token foi gerado no Mac e será aceito uma única vez. Defina agora a identidade do owner e uma frase-senha forte."
              : "A sessão é limitada, revogável e válida somente por HTTPS."}
          </p>
        </div>
        {!status && !error && (
          <p className="remote-auth-state" role="status">
            Confirmando o boundary de segurança…
          </p>
        )}
        {status && (
          <form onSubmit={(event) => void submit(event)}>
            {status.activationRequired && (
              <>
                <label>
                  Nome do owner
                  <input
                    autoComplete="name"
                    maxLength={120}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Token de ativação
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={bootstrapToken}
                    onChange={(event) =>
                      setBootstrapToken(event.target.value)
                    }
                    required
                  />
                  <small>Copie o token exibido por `npm run remote:init`.</small>
                </label>
              </>
            )}
            <label>
              Login
              <input
                autoComplete="username"
                maxLength={128}
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                required
              />
            </label>
            <label>
              Frase-senha
              <input
                type="password"
                autoComplete={
                  status.activationRequired
                    ? "new-password"
                    : "current-password"
                }
                maxLength={256}
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                required
              />
              <small>Mínimo de 16 caracteres; use uma frase única.</small>
            </label>
            {status.activationRequired && (
              <label>
                Confirmar frase-senha
                <input
                  type="password"
                  autoComplete="new-password"
                  maxLength={256}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  required
                />
              </label>
            )}
            {error && (
              <p className="workspace-form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={submitting}
            >
              {submitting
                ? "Verificando…"
                : status.activationRequired
                  ? "Ativar e entrar"
                  : "Entrar"}
              <span>→</span>
            </button>
          </form>
        )}
        {!status && error && (
          <p className="workspace-form-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          HTTPS obrigatório · cookie não acessível por scripts · sessão
          revogável
        </footer>
      </section>
    </main>
  );
}

function isAuthStatus(value: unknown): value is AuthStatus {
  return Boolean(
    value &&
      typeof value === "object" &&
      "mode" in value &&
      value.mode === "remote" &&
      "activationRequired" in value &&
      typeof value.activationRequired === "boolean" &&
      "authenticated" in value &&
      typeof value.authenticated === "boolean",
  );
}

function authErrorMessage(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : "";
  const messages: Record<string, string> = {
    activation_already_completed:
      "Este NexusOS já foi ativado. Atualize a página para entrar.",
    activation_token_invalid:
      "Token de ativação inválido. Use o valor gerado no Mac.",
    authentication_failed: "Login ou frase-senha inválidos.",
    csrf_validation_failed:
      "A origem da solicitação não passou pela verificação de segurança.",
    invalid_auth_request: "Revise os dados informados.",
    remote_auth_misconfigured:
      "O acesso remoto está incompleto no servidor.",
    too_many_login_attempts:
      "Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.",
  };
  return messages[code] ?? "Não foi possível concluir a autenticação.";
}
