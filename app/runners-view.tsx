"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RUNNER_TRUST_DISCLOSURE,
  type Runner,
  type RunnerRegistry,
} from "@/src/contracts/runners";
import { DiagnosticRunsPanel } from "./diagnostic-runs-panel";
import { toAssignableDiagnosticRunners } from "./diagnostic-run-view";
import { EngineRunsController } from "./engine-runs-controller";
import { RunnerAdmissionPolicyPanel } from "./admission-policy-panel";
import { RunnerCapabilityHistory } from "./runner-capability-history";
import { runnerCapabilityLabel } from "./runner-capability-labels";

type IssuedToken = {
  tokenId: string;
  token: string;
  expiresAt: string;
  displayName: string;
};

const RUNNER_RELEASE_CAPABILITIES: RunnerRegistry["capabilities"] = {
  identity: "real",
  heartbeat: "real",
  leases: "real",
  durableReplay: "real",
  capabilityProfiles: "real",
  execution: "real",
  sandbox: "roadmap",
  streaming: "roadmap",
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
  const registryRequestIdRef = useRef(0);
  const capabilities = state?.capabilities ?? RUNNER_RELEASE_CAPABILITIES;
  const capabilityStates = runnerCapabilityStates(capabilities);

  const loadRunners = useCallback(async (quiet = false) => {
    const requestId = registryRequestIdRef.current + 1;
    registryRequestIdRef.current = requestId;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/runners", { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as
        | RunnerRegistry
        | { error?: string };
      if (!response.ok || !("runners" in payload)) {
        throw new Error("runner_list_unavailable");
      }
      if (requestId !== registryRequestIdRef.current) return null;
      setState(payload);
      setLoadError("");
      return payload;
    } catch {
      if (requestId === registryRequestIdRef.current && !quiet) {
        setLoadError("Não foi possível consultar o registro de runners.");
      }
      return null;
    } finally {
      if (requestId === registryRequestIdRef.current && !quiet) {
        setLoading(false);
      }
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
      registryRequestIdRef.current += 1;
    };
  }, [issuedToken, loadRunners]);

  const setupCommand = useMemo(() => {
    if (!issuedToken) return "";
    if (!state) return "";
    return `npm run local:engine -- --engine <claude_code_cli|codex_cli> --path <caminho-absoluto> --server ${shellQuote(state.audience)} --name ${shellQuote(issuedToken.displayName)}`;
  }, [issuedToken, state]);
  const assignableRunners = useMemo(
    () => toAssignableDiagnosticRunners(state?.runners ?? []),
    [state?.runners],
  );
  const refreshRunnersAfterPolicyCommit = useCallback(() => {
    void loadRunners(true);
  }, [loadRunners]);

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
          <span className="eyebrow">RUNNER CONTROL PLANE · PERSISTENTE</span>
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
          state={capabilityStates.identity}
          detail="Ed25519 · chave privada local"
        />
        <CapabilityCard
          label="Heartbeat"
          state={capabilityStates.heartbeat}
          detail="Assinado · replay-safe"
        />
        <CapabilityCard
          label="Lease"
          state={capabilityStates.leases}
          detail="Diagnóstico · fence monotônico"
        />
        <CapabilityCard
          label="Replay"
          state={capabilityStates.durableReplay}
          detail="Outbox local · effect once"
        />
        <CapabilityCard
          label="Declarações"
          state={capabilityStates.capabilityProfiles}
          detail="Canal real · conteúdo hostReported não verificado"
        />
        <CapabilityCard
          label="Execução one-shot"
          state={capabilityStates.execution}
          detail="Provider CLI atribuído · sem retry, fallback ou tools"
        />
        <CapabilityCard
          label="Sandbox"
          state={capabilityStates.sandbox}
          detail="Isolamento de workload ainda não ativo"
        />
        <CapabilityCard
          label="Streaming"
          state={capabilityStates.streaming}
          detail="Tokens e eventos incrementais não são transmitidos por este fluxo"
        />
      </section>

      <section className="runner-trust-disclosure" data-testid="runner-trust-disclosure">
        <span aria-hidden="true">!</span>
        <div>
          <small>OPERATOR TRUST · LEIA ANTES DE CONECTAR</small>
          <h2>Identidade verificada não significa isolamento.</h2>
          <p>{state?.trustDisclosure ?? RUNNER_TRUST_DISCLOSURE}</p>
        </div>
      </section>

      <RunnerAdmissionPolicyPanel
        notify={notify}
        onPolicyCommitted={refreshRunnersAfterPolicyCommit}
      />

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
                  <b>Escolha a engine e informe o caminho absoluto do CLI</b>
                  <code data-testid="runner-setup-command">{setupCommand}</code>
                  <small>
                    Substitua os dois valores entre &lt;...&gt; antes de
                    executar. O comando não contém o token.
                  </small>
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
                  <b>Mantenha este processo ativo para readiness e heartbeat</b>
                  <small>
                    O registro abaixo atualiza automaticamente. Depois que o
                    runner aparecer, finalize a cerimônia. Sem{" "}
                    <code>--run</code>, o processo não procura trabalho. Cada
                    análise one-shot precisa ser iniciada explicitamente pelo
                    comando mostrado no detalhe do run.
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
                <RunnerDeclarationPanel
                  runner={runner}
                  disclosure={state.capabilityDisclosure}
                />
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

      <DiagnosticRunsPanel
        allowedCapabilities={
          state?.admissionPolicy.allowedCapabilities ?? null
        }
        assignableRunners={assignableRunners}
        notify={notify}
      />

      <EngineRunsController notify={notify} />

      <section className="runner-boundary-note">
        <b>O que está ativo agora</b>
        <p>
          Identidade, liveness, a declaração mais recente do host, sua
          explicação declarativa avaliada pelo servidor e execução one-shot
          atribuída via Claude Code CLI ou Codex CLI, com estado e receipt
          persistidos.
        </p>
        <b>O que ainda não está ativo</b>
        <p>
          Integridade do host, isolamento de processos, controle de filesystem
          ou rede, execução geral de tools, mutação de workspace, streaming ou
          garantia de aceitação de um claim futuro.
        </p>
      </section>
    </div>
  );
}

function CapabilityCard({
  label,
  state,
  detail,
}: {
  label: string;
  state: "REAL" | "INATIVO";
  detail: string;
}) {
  return (
    <article className={state === "REAL" ? "is-real" : "is-inactive"}>
      <span>
        <i />
        {state}
      </span>
      <h2>{label}</h2>
      <p>{detail}</p>
    </article>
  );
}

function capabilityState(state: "real" | "roadmap"): "REAL" | "INATIVO" {
  return state === "real" ? "REAL" : "INATIVO";
}

export function runnerCapabilityStates(
  capabilities: RunnerRegistry["capabilities"],
) {
  return {
    identity: capabilityState(capabilities.identity),
    heartbeat: capabilityState(capabilities.heartbeat),
    leases: capabilityState(capabilities.leases),
    durableReplay: capabilityState(capabilities.durableReplay),
    capabilityProfiles: capabilityState(capabilities.capabilityProfiles),
    execution: capabilityState(capabilities.execution),
    sandbox: capabilityState(capabilities.sandbox),
    streaming: capabilityState(capabilities.streaming),
  } as const;
}

export function RunnerDeclarationPanel({
  runner,
  disclosure,
}: {
  runner: Runner;
  disclosure: string;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const report = runner.declaredCapabilities;
  const projection = runner.declarationAdmission;
  return (
    <div
      className="runner-declaration"
      role="group"
      aria-label={`Declarações de capacidade de ${runner.displayName}`}
    >
      <header>
        <span className="runner-declared-badge">
          DECLARADO · hostReported · não verificada
        </span>
        <strong
          className={`runner-freshness freshness-${projection.freshnessState}`}
        >
          {declarationFreshnessLabel(projection.freshnessState)}
        </strong>
      </header>
      <p>
        {report
          ? `Recebido pelo servidor ${formatTimestamp(report.receivedAt)} · ${report.capabilities.length} de ${projection.capabilities.length} capacidades declaradas`
          : "Nenhuma declaração recebida. Identidade e heartbeat continuam independentes."}
      </p>
      {report?.truncated && (
        <p className="runner-declaration-warning">
          Declaração incompleta: o host informou que itens foram truncados.
        </p>
      )}
      <details
        onToggle={(event) => setDetailOpen(event.currentTarget.open)}
      >
        <summary>Ver capacidades e explicação da política</summary>
        <div className="runner-declaration-detail">
          <p className="runner-declaration-disclosure">{disclosure}</p>
          <dl>
            <div>
              <dt>Avaliado pelo servidor</dt>
              <dd>{formatTimestamp(projection.evaluatedAt)}</dd>
            </div>
            <div>
              <dt>Relatório recebido</dt>
              <dd>
                {projection.reportReceivedAt
                  ? `${formatTimestamp(projection.reportReceivedAt)} · idade ${formatAge(report?.ageSeconds ?? 0)}`
                  : "nenhum"}
              </dd>
            </div>
            <div>
              <dt>Coleta informada pelo host</dt>
              <dd>
                {report ? formatTimestamp(report.collectedAt) : "não informada"}
              </dd>
            </div>
            <div>
              <dt>Plataforma informada</dt>
              <dd>
                {report
                  ? `${report.platform.os} · ${report.platform.arch} · ${report.platform.nodeVersion}`
                  : "não informada"}
              </dd>
            </div>
            <div>
              <dt>Janela da política</dt>
              <dd>{formatDuration(projection.freshnessSeconds)}</dd>
            </div>
            <div>
              <dt>Fonte e versão</dt>
              <dd>
                {projection.policySource === "default"
                  ? `padrão virtual · v${projection.policyVersion}`
                  : `configurada · v${projection.policyVersion}`}
              </dd>
            </div>
            <div>
              <dt>Fresca sob a política atual até</dt>
              <dd>
                {projection.freshUntil
                  ? formatTimestamp(projection.freshUntil)
                  : "sem relatório"}
              </dd>
            </div>
          </dl>
          <ul className="runner-declaration-capabilities">
            {projection.capabilities.map((item) => {
              const evidence = report?.capabilities.find(
                (declared) => declared.capability === item.capability,
              );
              return (
                <li
                  key={item.capability}
                  className={`declared-status-${item.declaredStatus ?? "absent"}`}
                >
                  <div>
                    <b>{runnerCapabilityLabel(item.capability)}</b>
                    <span>
                      {declaredStatusLabel(item.declaredStatus)}
                    </span>
                  </div>
                  <small>{declarationReasonLabel(item.reason)}</small>
                  {evidence && (
                    <code>
                      {detectionLabel(evidence.detection)}
                      {` · ${capabilityReasonCodeLabel(evidence.reasonCode)}`}
                      {evidence.version ? ` · ${evidence.version}` : ""}
                    </code>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="runner-claim-boundary">
            Esta é uma projeção do snapshot acima. O servidor reavalia
            atribuição, prazo, leases, política e declaração no claim.
          </p>
          {detailOpen && (
            <RunnerCapabilityHistory
              key={runner.id}
              runnerId={runner.id}
              runnerName={runner.displayName}
            />
          )}
        </div>
      </details>
    </div>
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

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}min` : "",
    remainingSeconds ? `${remainingSeconds}s` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function formatAge(seconds: number) {
  return seconds < 60 ? "menos de 1min" : formatDuration(seconds);
}

function declarationFreshnessLabel(
  value: Runner["declarationAdmission"]["freshnessState"],
) {
  return {
    fresh: "FRESCA NO SNAPSHOT",
    stale: "FORA DA JANELA",
    future: "HORÁRIO FUTURO",
    absent: "SEM DECLARAÇÃO",
    not_evaluated: "NÃO AVALIADA",
  }[value];
}

function declaredStatusLabel(
  value: Runner["declarationAdmission"]["capabilities"][number]["declaredStatus"],
) {
  return value
    ? {
        available: "disponível",
        unavailable: "indisponível",
        unknown: "desconhecida",
      }[value]
    : "não declarada";
}

function declarationReasonLabel(
  value: Runner["declarationAdmission"]["capabilities"][number]["reason"],
) {
  return {
    satisfied: "Satisfaz a cláusula declarativa neste snapshot",
    invalid_policy: "Política inválida; avaliação interrompida",
    capability_disallowed: "Não permitida pela política da organização",
    declaration_absent: "Nenhum relatório foi recebido",
    declaration_future: "Horário do relatório está à frente do servidor",
    capability_absent: "O relatório não contém esta capacidade",
    capability_unavailable: "O host declarou indisponível",
    capability_unknown: "O host declarou estado desconhecido",
    declaration_stale: "Relatório fora da janela da política",
  }[value];
}

function detectionLabel(
  value: NonNullable<
    Runner["declaredCapabilities"]
  >["capabilities"][number]["detection"],
) {
  return {
    node_flag: "flag local do Node",
    binary_version: "versão em probe fixa",
    proc_read: "leitura local de procfs",
    syscall: "probe local de syscall",
    none: "sem detecção conclusiva",
  }[value];
}

function capabilityReasonCodeLabel(
  value: NonNullable<
    Runner["declaredCapabilities"]
  >["capabilities"][number]["reasonCode"],
) {
  return {
    none: "sem ressalva declarada",
    not_found: "não encontrado nas probes fixas",
    not_supported: "não suportado neste host",
    permission_denied: "probe sem permissão",
    probe_disabled: "probe desabilitada",
    unknown: "motivo desconhecido",
  }[value];
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
