import type {
  RunnerAdmissionPolicy,
  RunnerAdmissionPolicyResponse,
  RunnerCapabilityName,
} from "@/src/contracts/runners";
import {
  RUNNER_CAPABILITY_OPTIONS,
  runnerCapabilityLabel,
} from "./runner-capability-labels";
import {
  ENGINE_FRESHNESS_DEFAULT_SECONDS,
  ENGINE_FRESHNESS_MAX_SECONDS,
  ENGINE_FRESHNESS_MIN_SECONDS,
} from "@/src/domain/runners/engine-report-protocol";

export const POLICY_CAPABILITIES: readonly RunnerCapabilityName[] =
  RUNNER_CAPABILITY_OPTIONS;

const POLICY_CAPABILITY_SET = new Set<string>(POLICY_CAPABILITIES);
// Mirrors the server's closed vocabulary and 1h..30d policy bounds. A drift
// fails closed here and surfaces as an unavailable policy instead of guessing.
const MIN_POLICY_FRESHNESS_SECONDS = 3_600;
const MAX_POLICY_FRESHNESS_SECONDS = 30 * 86_400;

export function AdmissionPolicyView({
  response,
}: {
  response: RunnerAdmissionPolicyResponse;
}) {
  const { policy } = response;
  const viewState = admissionPolicyViewState(policy);
  const allowed = new Set(policy.allowedCapabilities);
  return (
    <article
      className={`runner-policy-card policy-${viewState}`}
      data-policy-state={viewState}
    >
      <header>
        <div>
          <span>POLÍTICA HUMANA · AVALIADA NO CLAIM</span>
          <h2>
            Quais declarações podem satisfazer a cláusula de capacidade.
          </h2>
        </div>
        <strong>{admissionPolicyStateLabel(policy)}</strong>
      </header>

      <p className="runner-policy-explanation">
        {viewState === "default"
          ? "Padrão virtual: nenhuma decisão foi gravada. As sete capacidades fechadas e o inventário de motores usam janelas independentes de 24 horas."
          : viewState === "deny-all"
            ? "Deny-all explícito: toda capacidade exigida por um diagnóstico atribuído falhará na cláusula declarativa. Atribuições sem capacidade exigida continuam independentes."
            : `${policy.allowedCapabilities.length} de ${POLICY_CAPABILITIES.length} capacidades podem satisfazer uma exigência explícita.`}
      </p>

      <dl className="runner-policy-facts">
        <div>
          <dt>Fonte</dt>
          <dd>
            {policy.source === "default"
              ? "padrão virtual · não persistido"
              : "decisão configurada"}
          </dd>
        </div>
        <div>
          <dt>Janela declarativa</dt>
          <dd>
            {formatPolicyDuration(policy.capabilityFreshnessSeconds)}
          </dd>
        </div>
        <div>
          <dt>Janela do inventário de motores</dt>
          <dd>{formatPolicyDuration(policy.engineFreshnessSeconds)}</dd>
        </div>
        <div>
          <dt>Versão</dt>
          <dd>v{policy.version}</dd>
        </div>
        <div>
          <dt>Última decisão</dt>
          <dd>
            {policy.updatedAt
              ? formatPolicyTimestamp(policy.updatedAt)
              : "nenhuma decisão gravada"}
          </dd>
        </div>
        <div>
          <dt>Ator</dt>
          <dd>{policy.updatedBy ?? "padrão do sistema"}</dd>
        </div>
        <div>
          <dt>Autoridade de edição</dt>
          <dd>
            {response.viewerCanEditPolicy
              ? "owner/admin · confirmada pelo servidor"
              : "somente leitura neste acesso"}
          </dd>
        </div>
      </dl>

      <ul className="runner-policy-capabilities">
        {POLICY_CAPABILITIES.map((capability) => {
          const isAllowed = allowed.has(capability);
          return (
            <li
              key={capability}
              className={isAllowed ? "is-allowed" : "is-denied"}
            >
              <span>{runnerCapabilityLabel(capability)}</span>
              <b>{isAllowed ? "PERMITIDA" : "NEGADA"}</b>
            </li>
          );
        })}
      </ul>

      <aside className="runner-policy-lease-boundary">
        <b>LEASE BOUNDARY</b>
        <p>
          Leases já ativas mantêm os pins de política e relatório usados no
          claim. Uma mudança vale somente para novas avaliações e não revoga
          trabalho em curso.
        </p>
      </aside>
    </article>
  );
}

export function admissionPolicyViewState(
  policy: RunnerAdmissionPolicy,
): "default" | "allow-list" | "deny-all" {
  if (policy.source === "default") return "default";
  return policy.allowedCapabilities.length === 0
    ? "deny-all"
    : "allow-list";
}

export function readRunnerAdmissionPolicyResponse(
  value: unknown,
): RunnerAdmissionPolicyResponse | null {
  if (!value || typeof value !== "object") return null;
  if (!hasExactKeys(value as Record<string, unknown>, [
    "policy",
    "viewerCanEditPolicy",
  ])) {
    return null;
  }
  const response = value as Partial<RunnerAdmissionPolicyResponse>;
  if (
    typeof response.viewerCanEditPolicy !== "boolean" ||
    !response.policy ||
    !isRunnerAdmissionPolicy(response.policy)
  ) {
    return null;
  }
  return {
    policy: {
      ...response.policy,
      allowedCapabilities: [...response.policy.allowedCapabilities],
    },
    viewerCanEditPolicy: response.viewerCanEditPolicy,
  };
}

export function mergeRunnerAdmissionPolicyResponse(
  current: RunnerAdmissionPolicyResponse | null,
  incoming: RunnerAdmissionPolicyResponse,
) {
  return current && incoming.policy.version < current.policy.version
    ? current
    : incoming;
}

function isRunnerAdmissionPolicy(
  value: unknown,
): value is RunnerAdmissionPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Partial<RunnerAdmissionPolicy>;
  const configured = policy.source === "configured";
  if (
    !hasExactKeys(
      value as Record<string, unknown>,
      configured
        ? [
            "allowedCapabilities",
            "capabilityFreshnessSeconds",
            "engineFreshnessSeconds",
            "source",
            "updatedAt",
            "updatedBy",
            "version",
          ]
        : [
            "allowedCapabilities",
            "capabilityFreshnessSeconds",
            "engineFreshnessSeconds",
            "source",
            "version",
          ],
    ) ||
    !Number.isSafeInteger(policy.version) ||
    Number(policy.version) < 0 ||
    (policy.source !== "default" && policy.source !== "configured") ||
    !Number.isSafeInteger(policy.capabilityFreshnessSeconds) ||
    Number(policy.capabilityFreshnessSeconds) <
      MIN_POLICY_FRESHNESS_SECONDS ||
    Number(policy.capabilityFreshnessSeconds) >
      MAX_POLICY_FRESHNESS_SECONDS ||
    !Number.isSafeInteger(policy.engineFreshnessSeconds) ||
    Number(policy.engineFreshnessSeconds) <
      ENGINE_FRESHNESS_MIN_SECONDS ||
    Number(policy.engineFreshnessSeconds) >
      ENGINE_FRESHNESS_MAX_SECONDS ||
    !Array.isArray(policy.allowedCapabilities) ||
    policy.allowedCapabilities.length > POLICY_CAPABILITIES.length
  ) {
    return false;
  }
  const unique = new Set(policy.allowedCapabilities);
  if (
    unique.size !== policy.allowedCapabilities.length ||
    !policy.allowedCapabilities.every(
      (capability) =>
        typeof capability === "string" &&
        POLICY_CAPABILITY_SET.has(capability),
    )
  ) {
    return false;
  }
  if (policy.source === "default") {
    return (
      policy.version === 0 &&
      policy.capabilityFreshnessSeconds === 86_400 &&
      policy.engineFreshnessSeconds ===
        ENGINE_FRESHNESS_DEFAULT_SECONDS &&
      policy.updatedAt === undefined &&
      policy.updatedBy === undefined &&
      POLICY_CAPABILITIES.every((capability) => unique.has(capability))
    );
  }
  return (
    Number(policy.version) >= 1 &&
    typeof policy.updatedAt === "string" &&
    isCanonicalPolicyTimestamp(policy.updatedAt) &&
    typeof policy.updatedBy === "string" &&
    policy.updatedBy.length > 0
  );
}

function admissionPolicyStateLabel(policy: RunnerAdmissionPolicy) {
  const state = admissionPolicyViewState(policy);
  if (state === "default") return "PADRÃO VIRTUAL · v0";
  if (state === "deny-all") {
    return `DENY-ALL CONFIGURADO · v${policy.version}`;
  }
  return `ALLOW-LIST CONFIGURADA · v${policy.version}`;
}

export function formatPolicyDuration(seconds: number) {
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

function formatPolicyTimestamp(value: string) {
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

function isCanonicalPolicyTimestamp(value: string) {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}
