"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RUNNER_TRUST_DISCLOSURE,
  type Runner,
  type RunnerRegistry,
} from "@/src/contracts/runners";
import { DiagnosticRunsPanel } from "./diagnostic-runs-panel";

type IssuedToken = {
  tokenId: string;
  token: string;
  expiresAt: string;
  displayName: string;
};

export function RunnersView({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const [state, setState] = useState<RunnerRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [mutationError, setMutationError] = useState("");

  const loadRunners = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/runners", { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as
        | RunnerRegistry
        | { error?: string };
      if (!response.ok || !("runners" in payload)) {
        throw new Error("runner_list_unavailable");
      }
      setState(payload);
      setLoadError("");
      return payload;
    } catch {
      if (!quiet) {
        setLoadError("Não foi possível consultar o registro de runners.");
      }
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void loadRunners();
    }, 0);
    const timer = window.setInterval(() => {
      void loadRunners(true);
    }, issuedToken ? 5_000 : 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [issuedToken, loadRunners]);

  const setupCommand = useMemo(() => {
    if (!issuedToken) return "";
    if (!state) return "";
    return `npm run runner -- enroll --server ${shellQuote(state.audience)} --name ${shellQuote(issuedToken.displayName)}`;
  }, [issuedToken, state]);

  const issueToken = async () => {
    const normalizedName = displayName.trim();
    if (!state) {
      setMutationError(
        "A configuração autoritativa do runner ainda não está disponível.",
      );
      return;
    }
    if (
      normalizedName.length < 1 ||
      normalizedName.length > 120 ||
      normalizedName !== displayName
    ) {
      setMutationError(
        "Informe um nome de 1 a 120 caracteres, sem espaços nas extremidades.",
      );
      return;
    }
    setIssuing(true);
    setMutationError("");
    try {
      const response = await fetch("/api/runners/enrollment-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: normalizedName }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        tokenId?: string;
        token?: string;
        expiresAt?: string;
        error?: string;
      };
      if (
        !response.ok ||
        !payload.tokenId ||
        !payload.token ||
        !payload.expiresAt
      ) {
        throw new Error(payload.error ?? "runner_token_issue_failed");
      }
      setIssuedToken({
        tokenId: payload.tokenId,
        token: payload.token,
        expiresAt: payload.expiresAt,
        displayName: normalizedName,
      });
      notify("Token de uso único emitido por 15 minutos");
    } catch (error) {
      setMutationError(runnerError(error));
    } finally {
      setIssuing(false);
    }
  };

  const cancelToken = async () => {
    if (!issuedToken) return;
    setRevokingId(issuedToken.tokenId);
    setMutationError("");
    try {
      const response = await fetch(
        `/api/runners/enrollment-tokens/${issuedToken.tokenId}/revoke`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok && response.status !== 409) {
        throw new Error(payload.error ?? "runner_token_revoke_failed");
      }
      setIssuedToken(null);
      setDisplayName("");
      await loadRunners(true);
      notify(
        response.status === 409
          ? "Token já consumido; registro de runners atualizado"
          : "Token revogado; o segredo exibido não pode mais ser usado",
      );
    } catch (error) {
      setMutationError(runnerError(error));
    } finally {
      setRevokingId("");
    }
  };

  const revokeRunner = async (runner: Runner) => {
    if (
      !window.confirm(
        `Revogar ${runner.displayName}? A chave deixará de autenticar no próximo heartbeat.`,
      )
    ) {
      return;
    }
    setRevokingId(runner.id);
    setMutationError("");
    try {
      const response = await fetch(`/api/runners/${runner.id}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "runner_revoke_failed");
      }
      await loadRunners(true);
      notify(`${runner.displayName} revogado com evento no Decision Ledger`);
    } catch (error) {
      setMutationError(runnerError(error));
    } finally {
      setRevokingId("");
    }
  };

  return (
    <div
      className="view-page runners-page"
      data-testid="runners-view"
      aria-busy={loading}
    >
      <div className="page-heading">
        <div>
          <span className="eyebrow">RUNNER CONTROL PLANE · REAL · S6.B2</span>
          <h1>Runners</h1>
          <p>
            Identidade de máquina e liveness verificáveis para infraestrutura
            sob seu controle.
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="outline-button"
            onClick={() => void loadRunners()}
            disabled={loading}
          >
            ↻ Atualizar
          </button>
          <button
            className="primary-button compact"
            data-testid="open-runner-enrollment"
            disabled={Boolean(issuedToken)}
            onClick={() =>
              document
                .querySelector<HTMLInputElement>("#runner-display-name")
                ?.focus()
            }
          >
            {issuedToken ? "Token ativo" : "＋ Conectar runner"}
          </button>
        </div>
      </div>

      <section className="runner-capabilities" aria-label="Capacidades do runner">
        <CapabilityCard
          label="Identidade"
          state="REAL"
          detail="Ed25519 · chave privada local"
          real
        />
        <CapabilityCard
          label="Heartbeat"
          state="REAL"
          detail="Assinado · replay-safe"
          real
        />
        <CapabilityCard
          label="Lease"
          state="REAL"
          detail="Diagnóstico · fence monotônico"
          real
        />
        <CapabilityCard
          label="Replay"
          state="REAL"
          detail="Outbox local · effect once"
          real
        />
        <CapabilityCard
          label="Execução"
          state="ROADMAP"
          detail="Sem shell ou tools nesta versão"
        />
        <CapabilityCard
          label="Sandbox"
          state="ROADMAP"
          detail="Host ainda não atestado"
        />
        <CapabilityCard
          label="Streaming"
          state="ROADMAP"
          detail="Eventos ricos chegam no S6.B5"
        />
      </section>

      <section className="runner-trust-disclosure" data-testid="runner-trust-disclosure">
        <span aria-hidden="true">!</span>
        <div>
          <small>OPERATOR TRUST · LEIA ANTES DE CONECTAR</small>
          <h2>Online não significa sandboxed.</h2>
          <p>{state?.trustDisclosure ?? RUNNER_TRUST_DISCLOSURE}</p>
        </div>
      </section>

      <section className="runner-enrollment-card">
        <div className="runner-enrollment-copy">
          <span className="section-number">01</span>
          <div>
            <span className="eyebrow">OUTBOUND-ONLY ENROLLMENT</span>
            <h2>Conecte um host sem enviar credenciais de modelo ao NexusOS.</h2>
            <p>
              O runner gera a chave Ed25519 no próprio host. O token bootstrap é
              mostrado uma vez, expira em 15 minutos e nunca entra no comando.
            </p>
          </div>
        </div>
        {!issuedToken ? (
          <form
            className="runner-enrollment-form"
            onSubmit={(event) => {
              event.preventDefault();
              void issueToken();
            }}
          >
            <label htmlFor="runner-display-name">Nome operacional do host</label>
            <div>
              <input
                id="runner-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Ex. mac-studio-scl-01"
                autoComplete="off"
                maxLength={120}
              />
              <button
                className="primary-button compact"
                type="submit"
                disabled={issuing || !state}
                data-testid="issue-runner-token"
              >
                {issuing ? "Emitindo…" : "Emitir token"}
              </button>
            </div>
            <small>
              Somente owner/admin pode emitir. A emissão entra no Decision
              Ledger.
            </small>
          </form>
        ) : (
          <div className="runner-token-ceremony" data-testid="runner-token-ceremony">
            <header>
              <div>
                <span className="eyebrow">SEGREDO EXIBIDO UMA ÚNICA VEZ</span>
                <h3>{issuedToken.displayName}</h3>
              </div>
              <time dateTime={issuedToken.expiresAt}>
                expira {formatTimestamp(issuedToken.expiresAt)}
              </time>
            </header>
            <ol>
              <li>
                <span>1</span>
                <div>
                  <b>Copie o comando — ele não contém o token</b>
                  <code data-testid="runner-setup-command">{setupCommand}</code>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(
                        setupCommand,
                        "Comando copiado sem segredo",
                        notify,
                      )
                    }
                  >
                    Copiar comando
                  </button>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <b>Execute e cole este token no prompt oculto</b>
                  <code className="runner-secret" data-testid="runner-one-time-token">
                    {issuedToken.token}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(
                        issuedToken.token,
                        "Token copiado; use apenas no prompt oculto",
                        notify,
                      )
                    }
                  >
                    Copiar token
                  </button>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <b>Mantenha o heartbeat ativo</b>
                  <code>npm run runner -- run</code>
                  <small>
                    O registro abaixo atualiza automaticamente. Depois que o
                    runner aparecer, finalize a cerimônia. O diagnóstico de
                    lease fica disponível abaixo; trabalho real continua
                    desabilitado.
                  </small>
                </div>
              </li>
            </ol>
            <button
              type="button"
              className="text-button danger-text"
              onClick={() => void cancelToken()}
              disabled={revokingId === issuedToken.tokenId}
            >
              {revokingId === issuedToken.tokenId
                ? "Revogando…"
                : "Finalizar cerimônia ou revogar token"}
            </button>
          </div>
        )}
      </section>

      {mutationError && (
        <p className="workspace-form-error runner-error" role="alert">
          {mutationError}
        </p>
      )}
      {loadError && (
        <section className="workspace-state-banner is-error" role="alert">
          <span>
            <b>Registro indisponível</b>
            <small>{loadError}</small>
          </span>
          <button onClick={() => void loadRunners()}>Tentar novamente</button>
        </section>
      )}

      <section className="runner-registry">
        <header>
          <div>
            <span className="section-number">02</span>
            <div>
              <span className="eyebrow">SIGNED MACHINE REGISTRY</span>
              <h2>Hosts matriculados</h2>
            </div>
          </div>
          <span>
            {state
              ? `${state.runners.filter((runner) => runner.status === "active").length} ativos · ${state.runners.length} total`
              : "carregando…"}
          </span>
        </header>
        {loading && !state && (
          <div className="runner-empty-state">
            Verificando identidades e heartbeats…
          </div>
        )}
        {state && state.runners.length === 0 && (
          <div className="runner-empty-state">
            <span>⌁</span>
            <div>
              <h3>Nenhum runner matriculado.</h3>
              <p>
                Emita um token acima e execute o cliente no host que permanecerá
                sob seu controle.
              </p>
            </div>
          </div>
        )}
        {state && state.runners.length > 0 && (
          <div className="runner-grid">
            {state.runners.map((runner) => (
              <article
                className={`runner-card runner-${runner.liveness}`}
                key={runner.id}
              >
                <header>
                  <div className="runner-machine-mark">⌁</div>
                  <div>
                    <span
                      className={`runner-liveness runner-liveness-${runner.liveness}`}
                    >
                      <i />
                      {livenessLabel(runner.liveness)}
                    </span>
                    <h3>{runner.displayName}</h3>
                    <code>{runner.id}</code>
                  </div>
                  <button
                    className="runner-menu-button"
                    aria-label={`Copiar fingerprint de ${runner.displayName}`}
                    title="Copiar fingerprint"
                    onClick={() =>
                      void copyText(
                        runner.publicKeyFingerprint,
                        "Fingerprint copiado",
                        notify,
                      )
                    }
                  >
                    ⧉
                  </button>
                </header>
                <dl>
                  <div>
                    <dt>Fingerprint</dt>
                    <dd title={runner.publicKeyFingerprint}>
                      {compactFingerprint(runner.publicKeyFingerprint)}
                    </dd>
                  </div>
                  <div>
                    <dt>Trust profile</dt>
                    <dd>{runner.trustProfile}</dd>
                  </div>
                  <div>
                    <dt>Matriculado</dt>
                    <dd>{formatTimestamp(runner.enrolledAt)}</dd>
                  </div>
                  <div>
                    <dt>Último heartbeat</dt>
                    <dd>
                      {runner.lastSeenAt
                        ? formatTimestamp(runner.lastSeenAt)
                        : "ainda não recebido"}
                    </dd>
                  </div>
                </dl>
                <footer>
                  <span>
                    <b>IDENTIDADE</b> verificada
                  </span>
                  {runner.status === "active" ? (
                    <button
                      className="text-button danger-text"
                      onClick={() => void revokeRunner(runner)}
                      disabled={revokingId === runner.id}
                    >
                      {revokingId === runner.id ? "Revogando…" : "Revogar"}
                    </button>
                  ) : (
                    <b className="runner-revoked-label">REVOGADO</b>
                  )}
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>

      <DiagnosticRunsPanel notify={notify} />

      <section className="runner-boundary-note">
        <b>O que S6.B2 garante</b>
        <p>
          Identidade, liveness, uma lease diagnóstica cercada e replay durável
          de uma conclusão registrada uma única vez.
        </p>
        <b>O que S6.B2 não garante</b>
        <p>
          Integridade do host, isolamento de processos, controle de filesystem
          ou rede, execução de tools e captura de evidência de outcomes.
        </p>
      </section>
    </div>
  );
}

function CapabilityCard({
  label,
  state,
  detail,
  real = false,
}: {
  label: string;
  state: "REAL" | "ROADMAP";
  detail: string;
  real?: boolean;
}) {
  return (
    <article className={real ? "is-real" : "is-roadmap"}>
      <span>
        <i />
        {state}
      </span>
      <h2>{label}</h2>
      <p>{detail}</p>
    </article>
  );
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function runnerError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    authentication_required: "Sua sessão precisa ser renovada.",
    forbidden: "Somente owner/admin pode gerenciar runners.",
    runner_token_consumed:
      "O token já foi consumido; atualize o registro para localizar o runner.",
    runner_token_not_found: "O token não pertence a este workspace.",
    runner_not_found: "O runner não pertence a este workspace.",
    conflict_retry: "Houve contenção no ledger. Tente novamente.",
  };
  return (
    messages[code] ??
    "Não foi possível concluir a operação de runner com segurança."
  );
}

function compactFingerprint(value: string) {
  return value.length > 30
    ? `${value.slice(0, 18)}…${value.slice(-10)}`
    : value;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "data inválida";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function livenessLabel(value: Runner["liveness"]) {
  return {
    pending: "Aguardando heartbeat",
    online: "Online",
    stale: "Sinal atrasado",
    offline: "Offline",
    revoked: "Revogado",
  }[value];
}

async function copyText(
  value: string,
  successMessage: string,
  notify: (message: string) => void,
) {
  try {
    await navigator.clipboard.writeText(value);
    notify(successMessage);
  } catch {
    notify("Não foi possível copiar; selecione o valor manualmente");
  }
}
