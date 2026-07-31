"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ProjectWorkGraph,
  type WorkGraphItem,
  type WorkGraphObjective,
} from "./work-graph-view";
import { PersistentAttentionView } from "./attention-view";
import { PersistentMessagesView } from "./messages-view";
import { PersistentRoomsView } from "./persistent-rooms-view";
import { OutputsView as PersistentOutputsView } from "./outputs-view";
import { PresenceProvider } from "./presence-client";
import { RealtimeProvider, useRealtime } from "./realtime-client";
import { IntentEvidencePanel } from "./intent-evidence-panel";
import { DecisionPackagePanel } from "./decision-package-panel";
import { RunnersView } from "./runners-view";
import { ProvidersView } from "./providers-view";
import {
  FIRST_RUN_STEPS,
  blankFirstRunDraft,
  buildSetupRequest,
  readWorkspaceBootstrap,
  setupErrorMessage,
  validateFirstRunStep,
  type FirstRunDraft,
  type FirstRunErrors,
  type FirstRunField,
  type FirstRunStep,
  type WorkspaceBootstrap,
} from "./first-run";
import { selectGovernanceIntent } from "@/src/domain/governance";

type View =
  | "messages"
  | "rooms"
  | "project"
  | "inbox"
  | "outputs"
  | "agents"
  | "runners"
  | "providers"
  | "ledger";

type Agent = {
  id: string;
  initials: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  method: "OAuth" | "CLI";
  connection: string;
  status: "Running" | "Ready" | "Waiting" | "Review" | "Illustrative";
  project: string;
  skills: number;
  memory: string;
  color: string;
};

type LiveGovernanceState = {
  intents: Array<{
    id: string;
    actionType: string;
    targetRef: string;
    riskTier: string;
    status: string;
    requiredApprovals: number;
    separationOfDuties: boolean;
    selfApprovalPolicy: "solo_owner" | null;
    proposerId: string;
    parametersHash: string;
    expiresAt: string;
    createdAt: string;
  }>;
  ledger: Array<{
    id: string;
    sequence: number;
    kind: string;
    actorId: string;
    hash: string;
    previousHash: string;
  }>;
  verification:
    | { valid: true; headHash: string; entries: number }
    | {
        valid: false;
        entryId: string;
        sequence: number;
        reason: string;
  };
};

type WorkspaceState = WorkspaceBootstrap & {
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    objective: string;
    status: "active" | "paused" | "archived";
    version: number;
  }>;
  teams: Array<{
    id: string;
    project_id: string;
    name: string;
    mission: string;
    status: "active" | "paused" | "archived";
    version: number;
    human_count: number;
    agent_count: number;
  }>;
  connections: Array<{
    id: string;
    provider: string;
    auth_method: "oauth" | "cli";
    label: string;
    status: "disconnected" | "ready" | "attention" | "archived";
    version: number;
  }>;
  agents: Array<{
    id: string;
    principal_id: string;
    connection_id: string | null;
    name: string;
    role: string;
    model: string;
    memory_scope: "run" | "project" | "team" | "governed_episodic";
    autonomy_level: "A0" | "A1" | "A2" | "A3";
    status: "active" | "paused" | "archived";
    version: number;
    provider: string | null;
    auth_method: "oauth" | "cli" | null;
    connection_label: string | null;
    connection_status: "disconnected" | "ready" | "attention" | null;
    teamIds: string[];
  }>;
  objectives: WorkGraphObjective[];
  workItems: WorkGraphItem[];
};

const navItems: Array<{ id: View; label: string; icon: string; group: "OPERAR" | "ENTREGAR" | "GOVERNAR" }> = [
  { id: "messages", label: "Mensagens", icon: "◌", group: "OPERAR" },
  { id: "rooms", label: "Team Rooms", icon: "⌗", group: "OPERAR" },
  { id: "inbox", label: "Inbox", icon: "◇", group: "OPERAR" },
  { id: "project", label: "Projetos", icon: "▦", group: "ENTREGAR" },
  { id: "outputs", label: "Outputs", icon: "▤", group: "ENTREGAR" },
  { id: "agents", label: "Times & agentes", icon: "◎", group: "GOVERNAR" },
  { id: "runners", label: "Runners", icon: "⌁", group: "GOVERNAR" },
  { id: "providers", label: "Provedores", icon: "⌁", group: "GOVERNAR" },
  { id: "ledger", label: "Decision Ledger", icon: "≋", group: "GOVERNAR" },
];

const mobileNavIds: View[] = [
  "project",
  "messages",
  "rooms",
  "inbox",
  "outputs",
];

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function Avatar({
  initials,
  color,
  small = false,
}: {
  initials: string;
  color: string;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${small ? "avatar-small" : ""}`}
      style={{ background: color }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`status-dot status-${status
        .toLowerCase()
        .replaceAll(" ", "-")}`}
      aria-label={status}
    />
  );
}

function Onboarding({
  reloadWorkspace,
  onComplete,
}: {
  reloadWorkspace: () => Promise<WorkspaceState>;
  onComplete: (workspace: WorkspaceState) => void;
}) {
  const [step, setStep] = useState<FirstRunStep>(0);
  const [draft, setDraft] = useState<FirstRunDraft>(blankFirstRunDraft);
  const [fieldErrors, setFieldErrors] = useState<FirstRunErrors>({});
  const [submissionError, setSubmissionError] = useState("");
  const [submissionPhase, setSubmissionPhase] = useState<
    "idle" | "submitting" | "reconcile_required"
  >("idle");
  const submitLatchRef = useRef(false);

  const updateField = (field: FirstRunField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSubmissionError("");
  };

  const advance = () => {
    if (step >= 3) return;
    const errors = validateFirstRunStep(draft, step);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setStep((step + 1) as FirstRunStep);
  };

  const reconcileSetup = async (): Promise<
    "completed" | "required" | "unavailable"
  > => {
    try {
      const workspace = await reloadWorkspace();
      if (!workspace.setupRequired) {
        onComplete(workspace);
        return "completed";
      }
      return "required";
    } catch {
      return "unavailable";
    }
  };

  const submitSetup = async () => {
    if (submitLatchRef.current) return;
    const built = buildSetupRequest(draft);
    if (!built.ok) {
      setFieldErrors(built.errors);
      setSubmissionError("Revise os campos destacados antes de continuar.");
      return;
    }

    submitLatchRef.current = true;
    setSubmissionPhase("submitting");
    setSubmissionError("");
    try {
      if (submissionPhase === "reconcile_required") {
        const resolution = await reconcileSetup();
        if (resolution === "completed") return;
        if (resolution === "required") {
          setSubmissionPhase("idle");
          setSubmissionError(
            "Nenhuma configuração foi confirmada. Agora é seguro tentar novamente.",
          );
        } else {
          setSubmissionPhase("reconcile_required");
          setSubmissionError(
            "Ainda não foi possível confirmar o resultado. Verifique novamente antes de reenviar.",
          );
        }
        return;
      }

      let response: Response;
      try {
        response = await fetch("/api/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(built.request),
        });
      } catch {
        const resolution = await reconcileSetup();
        if (resolution === "completed") return;
        if (resolution === "required") {
          setSubmissionPhase("idle");
          setSubmissionError(
            "A configuração não foi confirmada no servidor. Revise e tente novamente.",
          );
        } else {
          setSubmissionPhase("reconcile_required");
          setSubmissionError(
            "A conexão terminou sem resultado confirmado. Verifique o estado antes de reenviar.",
          );
        }
        return;
      }

      const payload: unknown = await response.json().catch(() => ({}));
      const returnedWorkspace = response.ok
        ? readWorkspaceState(payload)
        : null;
      if (returnedWorkspace && !returnedWorkspace.setupRequired) {
        onComplete(returnedWorkspace);
        return;
      }
      const resolution = await reconcileSetup();
      if (resolution === "completed") return;
      if (resolution === "unavailable") {
        setSubmissionPhase("reconcile_required");
        setSubmissionError(
          response.ok
            ? "A configuração foi recebida, mas o estado final ainda não pôde ser confirmado."
            : "A resposta não foi conclusiva. Verifique o estado antes de reenviar.",
        );
        return;
      }
      setSubmissionPhase("idle");
      setSubmissionError(
        response.ok
          ? "O servidor ainda informa que a configuração está pendente. Tente novamente."
          : setupErrorMessage(
              typeof payload === "object" &&
                payload !== null &&
                "error" in payload &&
                typeof payload.error === "string"
                ? payload.error
                : undefined,
            ),
      );
    } finally {
      submitLatchRef.current = false;
    }
  };

  return (
    <main className="onboarding-shell" data-testid="first-run-onboarding">
      <header className="onboarding-header">
        <button
          className="brand-button"
          disabled={submissionPhase === "submitting"}
          onClick={() => setStep(0)}
        >
          <BrandMark />
          <span>
            <b>NexusOS</b>
            <small>Hybrid operations</small>
          </span>
        </button>
        <span className="eyebrow">CONFIGURAÇÃO INICIAL · DADOS REAIS</span>
      </header>

      <section className="onboarding-progress" aria-label="Progresso">
        <span>
          {String(step + 1).padStart(2, "0")} /{" "}
          {String(FIRST_RUN_STEPS.length).padStart(2, "0")}
        </span>
        <div>
          {FIRST_RUN_STEPS.map((label, index) => (
            <button
              key={label}
              className={index <= step ? "is-active" : ""}
              disabled={index > step || submissionPhase === "submitting"}
              onClick={() => {
                setFieldErrors({});
                setSubmissionError("");
                setStep(index as FirstRunStep);
              }}
              aria-label={`Ir para ${label}`}
            />
          ))}
        </div>
        <strong>{FIRST_RUN_STEPS[step]}</strong>
      </section>

      {step === 0 && (
        <section className="onboarding-stage stage-project">
          <div className="stage-heading">
            <span className="eyebrow">01 · WORKSPACE</span>
            <h1>Crie o lugar onde seu trabalho será organizado.</h1>
            <p>
              Estes nomes serão gravados no workspace. Você poderá criar outros
              projetos e times depois desta configuração inicial.
            </p>
          </div>
          <div className="project-form-layout">
            <div className="project-form">
              <label>
                Nome do workspace
                <input
                  autoFocus
                  value={draft.workspaceName}
                  maxLength={80}
                  aria-invalid={Boolean(fieldErrors.workspaceName)}
                  aria-describedby={
                    fieldErrors.workspaceName
                      ? "first-run-workspace-name-error"
                      : undefined
                  }
                  onChange={(event) =>
                    updateField("workspaceName", event.target.value)
                  }
                  placeholder="Ex. Minha empresa"
                />
                {fieldErrors.workspaceName && (
                  <small
                    id="first-run-workspace-name-error"
                    className="workspace-form-error"
                    role="alert"
                  >
                    {fieldErrors.workspaceName}
                  </small>
                )}
              </label>
              <label>
                Seu nome
                <input
                  value={draft.ownerName}
                  maxLength={80}
                  aria-invalid={Boolean(fieldErrors.ownerName)}
                  aria-describedby={
                    fieldErrors.ownerName
                      ? "first-run-owner-name-error"
                      : undefined
                  }
                  onChange={(event) =>
                    updateField("ownerName", event.target.value)
                  }
                  placeholder="Como você aparecerá para o time"
                />
                {fieldErrors.ownerName && (
                  <small
                    id="first-run-owner-name-error"
                    className="workspace-form-error"
                    role="alert"
                  >
                    {fieldErrors.ownerName}
                  </small>
                )}
              </label>
            </div>
            <aside className="template-panel">
              <span className="card-kicker">O QUE SERÁ CRIADO</span>
              <h3>Um workspace sob sua responsabilidade</h3>
              <p>
                A configuração grava somente os dados informados neste fluxo.
                Nenhum exemplo será adicionado.
              </p>
            </aside>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="onboarding-stage stage-project">
          <div className="stage-heading">
            <span className="eyebrow">02 · PRIMEIRO PROJETO</span>
            <h2>Defina o primeiro resultado que será acompanhado.</h2>
            <p>
              O projeto e seu objetivo serão persistidos juntos com a
              configuração do workspace.
            </p>
          </div>
          <div className="project-form-layout">
            <div className="project-form">
              <label>
                Nome do projeto
                <input
                  autoFocus
                  value={draft.projectName}
                  maxLength={80}
                  aria-invalid={Boolean(fieldErrors.projectName)}
                  aria-describedby={
                    fieldErrors.projectName
                      ? "first-run-project-name-error"
                      : undefined
                  }
                  onChange={(event) =>
                    updateField("projectName", event.target.value)
                  }
                  placeholder="Ex. Lançamento do produto"
                />
                {fieldErrors.projectName && (
                  <small
                    id="first-run-project-name-error"
                    className="workspace-form-error"
                    role="alert"
                  >
                    {fieldErrors.projectName}
                  </small>
                )}
              </label>
              <label>
                Objetivo principal
                <textarea
                  value={draft.projectObjective}
                  maxLength={500}
                  aria-invalid={Boolean(fieldErrors.projectObjective)}
                  aria-describedby={
                    fieldErrors.projectObjective
                      ? "first-run-project-objective-error"
                      : undefined
                  }
                  onChange={(event) =>
                    updateField("projectObjective", event.target.value)
                  }
                  placeholder="Qual resultado este projeto deve alcançar?"
                />
                {fieldErrors.projectObjective && (
                  <small
                    id="first-run-project-objective-error"
                    className="workspace-form-error"
                    role="alert"
                  >
                    {fieldErrors.projectObjective}
                  </small>
                )}
              </label>
            </div>
            <aside className="template-panel">
              <span className="card-kicker">CONTEXTO INICIAL</span>
              <h3>Projeto e objetivo conectados</h3>
              <p>
                O objetivo orienta o Work Graph inicial e pode ser refinado na
                área de Projetos.
              </p>
            </aside>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="onboarding-stage stage-team">
          <div className="stage-heading">
            <span className="eyebrow">03 · PRIMEIRO TIME</span>
            <h2>Dê ao primeiro time uma missão clara.</h2>
            <p>
              O time será criado dentro do projeto informado na etapa anterior.
            </p>
          </div>
          <div className="project-form-layout">
            <div className="project-form">
              <label>
                Nome do time
                <input
                  autoFocus
                  value={draft.teamName}
                  maxLength={80}
                  aria-invalid={Boolean(fieldErrors.teamName)}
                  aria-describedby={
                    fieldErrors.teamName
                      ? "first-run-team-name-error"
                      : undefined
                  }
                  onChange={(event) =>
                    updateField("teamName", event.target.value)
                  }
                  placeholder="Ex. Produto e entrega"
                />
                {fieldErrors.teamName && (
                  <small
                    id="first-run-team-name-error"
                    className="workspace-form-error"
                    role="alert"
                  >
                    {fieldErrors.teamName}
                  </small>
                )}
              </label>
              <label>
                Missão
                <textarea
                  value={draft.teamMission}
                  maxLength={500}
                  aria-invalid={Boolean(fieldErrors.teamMission)}
                  aria-describedby={
                    fieldErrors.teamMission
                      ? "first-run-team-mission-error"
                      : undefined
                  }
                  onChange={(event) =>
                    updateField("teamMission", event.target.value)
                  }
                  placeholder="Pelo que este time será responsável?"
                />
                {fieldErrors.teamMission && (
                  <small
                    id="first-run-team-mission-error"
                    className="workspace-form-error"
                    role="alert"
                  >
                    {fieldErrors.teamMission}
                  </small>
                )}
              </label>
            </div>
            <aside className="template-panel">
              <span className="card-kicker">TIME INICIAL</span>
              <h3>Uma missão, um projeto</h3>
              <p>
                Humanos e agentes poderão ser adicionados depois. Esta etapa
                cria apenas o time e sua missão.
              </p>
            </aside>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="onboarding-stage stage-launch">
          <div className="stage-heading">
            <span className="eyebrow">04 · REVISÃO</span>
            <h2>Confirme a estrutura inicial.</h2>
            <p>
              O envio cria estes registros uma única vez. Se a conexão cair, o
              NexusOS confirmará o estado antes de permitir um novo envio.
            </p>
          </div>
          <div className="project-form-layout">
            <dl className="template-panel">
              <div>
                <dt>Workspace</dt>
                <dd>{draft.workspaceName.trim()}</dd>
              </div>
              <div>
                <dt>Responsável</dt>
                <dd>{draft.ownerName.trim()}</dd>
              </div>
              <div>
                <dt>Projeto</dt>
                <dd>{draft.projectName.trim()}</dd>
              </div>
              <div>
                <dt>Objetivo</dt>
                <dd>{draft.projectObjective.trim()}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>{draft.teamName.trim()}</dd>
              </div>
              <div>
                <dt>Missão</dt>
                <dd>{draft.teamMission.trim()}</dd>
              </div>
            </dl>
            <aside className="template-panel">
              <span className="card-kicker">CRIAÇÃO ATÔMICA</span>
              <h3>Nenhum dado parcial</h3>
              <p>
                Workspace, responsável, projeto e time serão confirmados juntos
                antes de abrir Projetos.
              </p>
            </aside>
          </div>
          {submissionError && (
            <p className="workspace-form-error" role="alert">
              {submissionError}
            </p>
          )}
          <div className="launch-copy">
            <button
              className="primary-button launch-button"
              data-testid="submit-first-run"
              disabled={submissionPhase === "submitting"}
              onClick={() => void submitSetup()}
            >
              {submissionPhase === "submitting"
                ? "Confirmando configuração…"
                : submissionPhase === "reconcile_required"
                  ? "Verificar configuração"
                  : "Criar workspace"}
              <span>→</span>
            </button>
          </div>
        </section>
      )}

      <footer className="onboarding-footer">
        {step > 0 ? (
          <button
            className="text-button"
            disabled={submissionPhase === "submitting"}
            onClick={() => {
              setFieldErrors({});
              setSubmissionError("");
              setStep((step - 1) as FirstRunStep);
            }}
          >
            ← Voltar
          </button>
        ) : (
          <span />
        )}
        {step < 3 && (
          <button
            className="primary-button compact"
            data-testid="onboarding-next"
            onClick={advance}
          >
            Continuar <span>→</span>
          </button>
        )}
      </footer>
    </main>
  );
}

function displayLabel(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function initialsFor(value: string, maximum = 2): string {
  const words = value
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const initials = words
    .slice(0, maximum)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "N";
}

function principalRoleLabel(
  role: WorkspaceState["currentPrincipal"]["role"],
): string {
  if (!role) return "Usuário autenticado";
  return {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
    viewer: "Viewer",
  }[role];
}

function Sidebar({
  view,
  onNavigate,
  workspace,
  conversationCount,
  attentionCount,
}: {
  view: View;
  onNavigate: (view: View) => void;
  workspace: WorkspaceState;
  conversationCount: number | null;
  attentionCount: number | null;
}) {
  const currentProjects =
    workspace.projects.filter((project) => project.status !== "archived");
  const organizationName = displayLabel(
    workspace.organization.name,
    "Workspace",
  );
  const principalName = displayLabel(
    workspace.currentPrincipal.displayName,
    "Usuário",
  );

  return (
    <aside className="app-sidebar">
      <button className="brand-button sidebar-brand" onClick={() => onNavigate("project")}>
        <BrandMark />
        <span>
          <b>NexusOS</b>
          <small>Operating fabric</small>
        </span>
      </button>
      <button className="org-switcher" data-testid="org-switcher">
        <span className="org-monogram">{initialsFor(organizationName, 1)}</span>
        <span>
          <b>{organizationName}</b>
          <small>
            Workspace atual · {currentProjects.length} projetos
          </small>
        </span>
      </button>
      <nav className="main-nav" aria-label="Navegação principal">
        {(["OPERAR", "ENTREGAR", "GOVERNAR"] as const).map((group) => (
          <div className="nav-group" key={group}>
            <span className="nav-label">{group}</span>
            {navItems.filter((item) => item.group === group).map((item) => (
              <button
                key={item.id}
                data-testid={`nav-${item.id}`}
                className={view === item.id ? "is-active" : ""}
                onClick={() => onNavigate(item.id)}
              >
                <i>{item.icon}</i>
                <span>{item.label}</span>
                {item.id === "messages" && conversationCount !== null && (
                  <b
                    className="nav-count conversation-total-count"
                    title={`${conversationCount} conversas persistentes`}
                    aria-label={`${conversationCount} conversas persistentes`}
                  >
                    {conversationCount}
                  </b>
                )}
                {item.id === "inbox" &&
                  attentionCount !== null &&
                  attentionCount > 0 && (
                    <b
                      className="nav-count"
                      title={`${attentionCount} itens na sua fila de atenção`}
                      aria-label={`${attentionCount} itens na sua fila de atenção`}
                    >
                      {attentionCount}
                    </b>
                  )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-projects">
        <span className="nav-label">PROJETOS AO VIVO</span>
        {currentProjects.length === 0 && (
          <button
            className="sidebar-project-empty"
            onClick={() => onNavigate("project")}
          >
            ＋ Criar primeiro projeto
          </button>
        )}
        {currentProjects.map((project) => {
            const teamIds = new Set(
              workspace.teams
                .filter(
                  (team) =>
                    team.project_id === project.id && team.status === "active",
                )
                .map((team) => team.id),
            );
            const activeAgents = workspace.agents.filter(
              (agent) =>
                agent.status === "active" &&
                agent.teamIds.some((teamId) => teamIds.has(teamId)),
            ).length;
            return (
              <button
                key={project.id}
                onClick={() => onNavigate("project")}
                className="sidebar-project"
              >
                <i>{project.name.slice(0, 1).toUpperCase()}</i>
                <span>
                  <b>{project.name}</b>
                  <small>{activeAgents} agentes ativos</small>
                </span>
                {project.status === "paused" && <em>PAUSA</em>}
              </button>
            );
          })}
      </div>
      <div className="sidebar-bottom">
        <div className="user-chip">
          <Avatar initials={initialsFor(principalName)} color="#d7defa" small />
          <span>
            <b>{principalName}</b>
            <small>{principalRoleLabel(workspace.currentPrincipal.role)}</small>
          </span>
          <i>•••</i>
        </div>
      </div>
    </aside>
  );
}

function AppHeader({
  onCommand,
  onProvider,
  currentPrincipal,
}: {
  onCommand: () => void;
  onProvider: () => void;
  currentPrincipal: WorkspaceState["currentPrincipal"];
}) {
  const realtime = useRealtime();
  const realtimeLabel =
    realtime.status === "live"
      ? "Realtime live"
      : realtime.status === "connecting" ||
          realtime.status === "reconnect_wait"
        ? "Realtime connecting"
        : "Polling fallback";
  return (
    <header className="app-header">
      <button className="global-search" onClick={onCommand}>
        <span>⌕</span>
        Pergunte ou acione qualquer projeto…
        <kbd>⌘ K</kbd>
      </button>
      <div className="header-actions">
        <button
          className={`system-health realtime-${realtime.status}`}
          onClick={onProvider}
          title="A leitura autoritativa continua em D1 em todos os modos."
        >
          <span />
          {realtimeLabel}
        </button>
        <button className="icon-button" aria-label="Ajuda">?</button>
        <button className="icon-button notification-button" aria-label="Notificações">
          ◌ <span />
        </button>
        <Avatar
          initials={initialsFor(
            displayLabel(currentPrincipal.displayName, "Usuário"),
          )}
          color="#d7defa"
          small
        />
      </div>
    </header>
  );
}

function ProjectView({
  notify,
  onOpenOutputs,
}: {
  notify: (message: string) => void;
  onOpenOutputs: (workItemId: string) => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceMutationError, setWorkspaceMutationError] = useState("");
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [reloadWorkspace, setReloadWorkspace] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectFilter, setProjectFilter] = useState<"current" | "archived">(
    "current",
  );
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState({
    name: "",
    objective: "",
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/workspace", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error("workspace unavailable");
        }
        return response.json() as Promise<WorkspaceState>;
      })
      .then((state) => {
        setWorkspace(state);
        setWorkspaceError("");
        setSelectedProjectId((current) =>
          state.projects.some((project) => project.id === current)
            ? current
            : state.projects.find((project) => project.status !== "archived")
                ?.id ??
              state.projects[0]?.id ??
              "",
        );
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name !== "AbortError") {
          setWorkspaceError(
            "Não foi possível carregar os projetos persistentes.",
          );
        }
      });
    return () => controller.abort();
  }, [reloadWorkspace]);

  useEffect(() => {
    if (!projectEditorOpen) {
      return;
    }
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="project-editor"]',
    );
    if (!dialog) {
      return;
    }
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    focusable[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !workspaceSaving) {
        setProjectEditorOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [projectEditorOpen, workspaceSaving]);

  const visibleProjects =
    workspace?.projects.filter((project) =>
      projectFilter === "archived"
        ? project.status === "archived"
        : project.status !== "archived",
    ) ?? [];
  const selectedProject =
    visibleProjects.find((project) => project.id === selectedProjectId) ??
    visibleProjects[0];
  const projectTeams =
    workspace?.teams.filter((team) => team.project_id === selectedProject?.id) ??
    [];
  const projectTeamIds = new Set(projectTeams.map((team) => team.id));
  const projectAgents =
    workspace?.agents.filter((agent) =>
      agent.teamIds.some((teamId) => projectTeamIds.has(teamId)),
    ) ?? [];

  const openNewProject = () => {
    setProjectDraft({ name: "", objective: "" });
    setWorkspaceMutationError("");
    setEditingProjectId(null);
    setProjectEditorOpen(true);
  };

  const openProjectEditor = () => {
    if (!selectedProject) {
      return;
    }
    setProjectDraft({
      name: selectedProject.name,
      objective: selectedProject.objective,
    });
    setWorkspaceMutationError("");
    setEditingProjectId(selectedProject.id);
    setProjectEditorOpen(true);
  };

  const mutateProject = async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ) => {
    setWorkspaceSaving(true);
    setWorkspaceMutationError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        id?: string;
      };
      if (!response.ok) {
        setWorkspaceMutationError(
          workspaceErrorMessage(
            payload.error ?? "workspace_operation_failed",
          ),
        );
        if (response.status === 409) {
          setReloadWorkspace((value) => value + 1);
        }
        return null;
      }
      window.dispatchEvent(new Event("nexus-workspace-changed"));
      setReloadWorkspace((value) => value + 1);
      return payload;
    } catch {
      setWorkspaceMutationError("A operação não chegou ao workspace local.");
      return null;
    } finally {
      setWorkspaceSaving(false);
    }
  };

  const saveProject = async () => {
    const storedProject = workspace?.projects.find(
      (project) => project.id === editingProjectId,
    );
    const result =
      editingProjectId && storedProject
        ? await mutateProject(
            `/api/workspace/projects/${editingProjectId}`,
            "PATCH",
            {
              expectedVersion: storedProject.version,
              name: projectDraft.name,
              objective: projectDraft.objective,
            },
          )
        : await mutateProject("/api/workspace/projects", "POST", {
            slug: workspaceSlug(projectDraft.name),
            name: projectDraft.name,
            objective: projectDraft.objective,
          });
    if (!result) {
      return;
    }
    if (!editingProjectId && result.id) {
      setSelectedProjectId(result.id);
      setProjectFilter("current");
    }
    setProjectEditorOpen(false);
    notify(
      editingProjectId
        ? `${projectDraft.name} atualizado no D1`
        : `${projectDraft.name} criado no D1`,
    );
  };

  const changeProjectStatus = async (
    project: WorkspaceState["projects"][number],
    status: WorkspaceState["projects"][number]["status"],
  ) => {
    const result = await mutateProject(
      `/api/workspace/projects/${project.id}`,
      "PATCH",
      { expectedVersion: project.version, status },
    );
    if (!result) {
      return;
    }
    setProjectEditorOpen(false);
    setProjectFilter(status === "archived" ? "archived" : "current");
    notify(
      status === "archived"
        ? `${project.name} arquivado com histórico preservado`
        : status === "paused"
          ? `${project.name} pausado`
          : `${project.name} ativo`,
    );
  };

  return (
    <div
      className="view-page project-page"
      data-testid="project-view"
      aria-busy={!workspace && !workspaceError}
    >
      <div className="page-heading project-directory-heading">
        <div>
          <span className="eyebrow">OUTCOME PORTFOLIO</span>
          <h1>Projetos</h1>
          <p>Objetivos, times e responsabilidades em um workspace persistente.</p>
        </div>
        <div className="heading-actions">
          <div className="project-status-filter" aria-label="Filtro de projetos">
            <button
              className={projectFilter === "current" ? "is-active" : ""}
              onClick={() => setProjectFilter("current")}
            >
              Atuais
            </button>
            <button
              className={projectFilter === "archived" ? "is-active" : ""}
              onClick={() => setProjectFilter("archived")}
            >
              Arquivados
            </button>
          </div>
          <button
            className="primary-button compact"
            data-testid="open-project-editor"
            disabled={!workspace || workspaceSaving}
            onClick={openNewProject}
          >
            ＋ Novo projeto
          </button>
        </div>
      </div>

      {workspaceError && (
        <section className="workspace-state-banner is-error" role="alert">
          <span>
            <b>Workspace indisponível</b>
            <small>{workspaceError}</small>
          </span>
          <button onClick={() => setReloadWorkspace((value) => value + 1)}>
            Tentar novamente
          </button>
        </section>
      )}
      {!workspace && !workspaceError && (
        <section className="workspace-state-banner is-loading">
          <span>
            <b>Carregando portfólio persistente…</b>
            <small>Projetos, times e assignments em D1</small>
          </span>
        </section>
      )}
      {workspace && (
        <div className="real-data-disclosure">
          <b>REAL · LOCAL D1</b>
          <span>
            CRUD, status e composição vêm da API persistente. Work graph,
            métricas, memória e evidence estão sinalizados como visioning.
          </span>
        </div>
      )}

      {workspace && (
        <section className="team-selector project-selector">
          {visibleProjects.map((project) => {
            const teamsForProject = workspace.teams.filter(
              (team) =>
                team.project_id === project.id && team.status === "active",
            );
            const teamIds = new Set(teamsForProject.map((team) => team.id));
            const agentsForProject = workspace.agents.filter(
              (agent) =>
                agent.status === "active" &&
                agent.teamIds.some((teamId) => teamIds.has(teamId)),
            );
            return (
              <button
                key={project.id}
                className={
                  selectedProject?.id === project.id ? "is-selected" : ""
                }
                onClick={() => setSelectedProjectId(project.id)}
              >
                <span>
                  <i>{project.name.slice(0, 1).toUpperCase()}</i>
                  <span>
                    <small>
                      {project.status.toUpperCase()} · v{project.version}
                    </small>
                    <b>{project.name}</b>
                  </span>
                </span>
                <p>{project.objective}</p>
                <footer>
                  <span>{teamsForProject.length} times</span>
                  <span>{agentsForProject.length} agentes</span>
                  <em>→</em>
                </footer>
              </button>
            );
          })}
          {projectFilter === "current" && (
            <button className="new-team-card" onClick={openNewProject}>
              <span>＋</span>
              <b>Criar projeto</b>
              <small>Objetivo, times e operação</small>
            </button>
          )}
        </section>
      )}

      {workspace && visibleProjects.length === 0 && (
        <section className="workspace-empty-state">
          <span>01</span>
          <div>
            <h2>
              {projectFilter === "archived"
                ? "Nenhum projeto arquivado"
                : "Seu primeiro projeto começa aqui"}
            </h2>
            <p>
              {projectFilter === "archived"
                ? "Projetos arquivados preservam histórico e podem ser restaurados."
                : "Defina um objetivo concreto antes de configurar times e agentes."}
            </p>
          </div>
          {projectFilter === "current" && (
            <button onClick={openNewProject}>＋ Criar projeto</button>
          )}
        </section>
      )}

      {selectedProject && (
        <>
          <div className="project-record-actions">
            <span>
              <b>{selectedProject.status.toUpperCase()}</b>
              <small>Registro persistente · versão {selectedProject.version}</small>
            </span>
            <div>
              <button className="outline-button" onClick={openProjectEditor}>
                Editar projeto
              </button>
              {selectedProject.status !== "archived" && (
                <button
                  className="outline-button"
                  disabled={workspaceSaving}
                  onClick={() =>
                    void changeProjectStatus(
                      selectedProject,
                      selectedProject.status === "paused" ? "active" : "paused",
                    )
                  }
                >
                  {selectedProject.status === "paused" ? "Retomar" : "Pausar"}
                </button>
              )}
            </div>
          </div>
          {workspaceMutationError && !projectEditorOpen && (
            <p className="workspace-form-error" role="alert">
              {workspaceMutationError}
            </p>
          )}
          <ProjectOperatingView
            project={selectedProject}
            teams={projectTeams}
            projectAgents={projectAgents}
            objectives={workspace?.objectives ?? []}
            workItems={workspace?.workItems ?? []}
            onWorkGraphChanged={() =>
              setReloadWorkspace((value) => value + 1)
            }
            onOpenOutputs={onOpenOutputs}
            notify={notify}
          />
        </>
      )}

      {projectEditorOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setProjectEditorOpen(false)}
        >
          <form
            className="entity-editor compact-editor"
            data-testid="project-editor"
            role="dialog"
            aria-modal="true"
            aria-label={
              editingProjectId ? "Editar projeto" : "Criar novo projeto"
            }
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void saveProject();
            }}
          >
            <header>
              <div>
                <span className="eyebrow">PROJECT STUDIO</span>
                <h2>{editingProjectId ? "Editar projeto" : "Novo projeto"}</h2>
                <p>Todo projeto nasce com um objetivo explícito e versionado.</p>
              </div>
              <button
                type="button"
                onClick={() => setProjectEditorOpen(false)}
              >
                ×
              </button>
            </header>
            <label>
              Nome do projeto
              <input
                value={projectDraft.name}
                onChange={(event) =>
                  setProjectDraft({
                    ...projectDraft,
                    name: event.target.value,
                  })
                }
                placeholder="Ex. Revenue Intelligence"
              />
            </label>
            <label>
              Objetivo
              <textarea
                value={projectDraft.objective}
                onChange={(event) =>
                  setProjectDraft({
                    ...projectDraft,
                    objective: event.target.value,
                  })
                }
                placeholder="Outcome mensurável pelo qual este projeto existe"
              />
            </label>
            {workspaceMutationError && (
              <p className="workspace-form-error" role="alert">
                {workspaceMutationError}
              </p>
            )}
            <footer>
              {editingProjectId && selectedProject && (
                <button
                  type="button"
                  className="text-button danger-text"
                  disabled={workspaceSaving}
                  onClick={() =>
                    void changeProjectStatus(
                      selectedProject,
                      selectedProject.status === "archived"
                        ? "active"
                        : "archived",
                    )
                  }
                >
                  {selectedProject.status === "archived"
                    ? "Restaurar projeto"
                    : "Arquivar projeto"}
                </button>
              )}
              <button
                type="button"
                className="text-button"
                disabled={workspaceSaving}
                onClick={() => setProjectEditorOpen(false)}
              >
                Cancelar
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={workspaceSaving}
              >
                {workspaceSaving ? "Salvando…" : "Salvar projeto"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

function ProjectOperatingView({
  project,
  teams,
  projectAgents,
  objectives,
  workItems,
  onWorkGraphChanged,
  onOpenOutputs,
  notify,
}: {
  project: WorkspaceState["projects"][number];
  teams: WorkspaceState["teams"];
  projectAgents: WorkspaceState["agents"];
  objectives: WorkGraphObjective[];
  workItems: WorkGraphItem[];
  onWorkGraphChanged: () => void;
  onOpenOutputs: (workItemId: string) => void;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState("work");

  return (
    <div className="project-operating-preview">
      <div className="project-hero">
        <div className="project-title-area">
          <span className="project-icon large" style={{ background: "#e7f6c7", color: "#4f6818" }}>{project.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <span className="eyebrow">PROJETO · {project.status.toUpperCase()} · V{project.version}</span>
            <h1>{project.name}</h1>
            <p>{teams.filter((team) => team.status === "active").length} times ativos · {projectAgents.filter((agent) => agent.status === "active").length} agentes ativos</p>
          </div>
        </div>
        <div className="project-hero-actions">
          <span className={project.status === "active" ? "health health-on-track" : "health health-needs-attention"}><i /> {project.status}</span>
          <button className="primary-button compact" onClick={() => setTab("work")}>Abrir Work Graph</button>
        </div>
      </div>

      <section className="objective-strip">
        <div>
          <span className="eyebrow">OBJETIVO PERSISTENTE</span>
          <h2>{project.objective}</h2>
          <p>Workspace local · optimistic concurrency · versão {project.version}</p>
        </div>
        <div className="objective-progress">
          <strong>{teams.filter((team) => team.status === "active").length}</strong>
          <span><b>times ativos</b><small>{teams.length} configurados</small></span>
        </div>
        <div className="objective-metrics">
          <span><small>AGENTES ATIVOS</small><b>{projectAgents.filter((agent) => agent.status === "active").length}</b><em>{projectAgents.length} assignments</em></span>
          <span><small>WORK GRAPH</small><b>{workItems.filter((item) => item.project_id === project.id).length}</b><em>{objectives.filter((objective) => objective.project_id === project.id && objective.status === "active").length} objetivos ativos</em></span>
        </div>
      </section>

      <div className="project-tabs">
        {[
          ["work", "Work · real"],
          ["team", "Time híbrido · real"],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "work" && (
        <ProjectWorkGraph
          key={project.id}
          projectId={project.id}
          objectives={objectives}
          workItems={workItems}
          onChanged={onWorkGraphChanged}
          onOpenOutputs={onOpenOutputs}
          notify={notify}
        />
      )}

      {tab === "team" && (
        <section className="team-tab-grid">
          {teams.map((team) => (
            <article className="agent-profile-card" key={team.id}>
              <div className="agent-profile-top">
                <Avatar initials={team.name.slice(0, 2).toUpperCase()} color={agentColor(team.id)} />
                <span className="state-cell"><StatusDot status={team.status === "active" ? "Ready" : "Waiting"} />{team.status}</span>
              </div>
              <span className="member-type">TIME HÍBRIDO · V{team.version}</span>
              <h3>{team.name}</h3>
              <p>{team.mission}</p>
              <dl>
                <div><dt>Humanos</dt><dd>{Number(team.human_count)}</dd></div>
                <div><dt>Agentes</dt><dd>{Number(team.agent_count)}</dd></div>
              </dl>
            </article>
          ))}
          {projectAgents.map((agent) => (
            <article className="agent-profile-card" key={agent.id}>
              <div className="agent-profile-top">
                <Avatar initials={agent.name.slice(0, 2).toUpperCase()} color={agentColor(agent.id)} />
                <span className="state-cell"><StatusDot status={agent.status === "active" ? "Ready" : "Waiting"} />{agent.status}</span>
              </div>
              <span className="member-type">AGENTE · {agent.autonomy_level}</span>
              <h3>{agent.name}</h3>
              <p>{agent.role}</p>
              <dl>
                <div><dt>Modelo</dt><dd>{agent.model}</dd></div>
                <div><dt>Conexão</dt><dd>{agent.connection_label ?? "Não atribuída"}</dd></div>
                <div><dt>Memória</dt><dd>{memoryScopeLabel(agent.memory_scope)}</dd></div>
              </dl>
            </article>
          ))}
        </section>
      )}

    </div>
  );
}

function MessagesView({
  onProject,
  onOutput,
  notify,
  workspace,
  drafts,
  onDraftChange,
  initialConversationId,
  onInitialConversationConsumed,
}: {
  onProject: () => void;
  onOutput: () => void;
  notify: (message: string) => void;
  workspace: WorkspaceState | null;
  drafts: Record<string, string>;
  onDraftChange: (conversationId: string, value: string) => void;
  initialConversationId?: string;
  onInitialConversationConsumed?: () => void;
}) {
  return (
    <PersistentMessagesView
      onProject={onProject}
      onOutput={onOutput}
      notify={notify}
      workspace={workspace}
      drafts={drafts}
      onDraftChange={onDraftChange}
      initialConversationId={initialConversationId}
      onInitialConversationConsumed={onInitialConversationConsumed}
    />
  );
}

function RoomsView({
  onMessage,
  notify,
}: {
  onMessage: (conversationId: string) => void;
  notify: (message: string) => void;
}) {
  return <PersistentRoomsView onMessage={onMessage} notify={notify} />;
}

export function VisionRoomsDemo({
  onMessage,
  notify,
}: {
  onMessage: () => void;
  notify: (message: string) => void;
}) {
  const rooms = [
    { id: "checkout", name: "Checkout Evolution", type: "Team room", activity: "PR #482 · rollout review", people: 4, tone: "lime", members: [["RC", "Rafael", "Speaking"], ["AT", "Atlas", "Sharing output"], ["CM", "Camila", "Reviewing"], ["SE", "Sentinel", "Listening"]] },
    { id: "orion", name: "Orion War Room", type: "Incident room", activity: "Migration wave 3 · R2", people: 3, tone: "orange", members: [["LU", "Luma", "Presenting"], ["FG", "Forge", "Working"], ["MP", "Marina", "Listening"]] },
    { id: "research", name: "Research Studio", type: "Open room", activity: "Customer evidence synthesis", people: 2, tone: "violet", members: [["CM", "Camila", "Pairing"], ["LU", "Luma", "Analyzing"]] },
    { id: "lounge", name: "Agent Commons", type: "Ambient room", activity: "2 agents available for handoff", people: 2, tone: "cyan", members: [["NX", "Nexus", "Available"], ["SC", "Scout", "Available"]] },
  ];
  const [selectedId, setSelectedId] = useState("checkout");
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [mediaMode, setMediaMode] = useState<"chat" | "audio" | "video">("audio");
  const selected = rooms.find((room) => room.id === selectedId) ?? rooms[0];

  return (
    <div className="view-page rooms-page" data-testid="rooms-view">
      <div className="page-heading">
        <div><span className="eyebrow">LIVE PRESENCE</span><h1>Team Rooms</h1><p>Veja onde humanos e agentes estão, com quem colaboram e em qual contexto.</p></div>
        <div className="heading-actions"><button className="outline-button" onClick={() => notify("Status alterado para disponível")}>● Disponível ⌄</button><button className="primary-button compact" data-testid="start-meeting" onClick={() => setMeetingOpen(true)}>＋ Abrir reunião</button></div>
      </div>
      <section className="presence-summary">
        <div><span className="presence-live" /><span><small>ONLINE AGORA</small><b>18 membros</b></span></div>
        <div><small>HUMANS</small><b>10</b><em>2 speaking</em></div>
        <div><small>AGENTS</small><b>8</b><em>5 running · 3 ready</em></div>
        <div><small>ACTIVE ROOMS</small><b>4</b><em>11 collaborating</em></div>
        <div><small>DEEP WORK / DND</small><b>3</b><em>until 14:00</em></div>
      </section>
      <div className="rooms-layout">
        <section className="virtual-office">
          <header><div><span className="eyebrow">AURORA HQ · FLOOR 01</span><h2>Product & Engineering</h2></div><div><button className="is-active">Map</button><button>List</button><button>All floors ⌄</button></div></header>
          <div className="office-map">
            {rooms.map((room) => (
              <button key={room.id} className={`room-card room-${room.tone} ${selected.id === room.id ? "is-selected" : ""}`} onClick={() => setSelectedId(room.id)}>
                <header><span><i /> {room.type.toUpperCase()}</span><em>{room.people} inside</em></header>
                <h3>{room.name}</h3>
                <p>{room.activity}</p>
                <div className="room-members">
                  {room.members.map((member, index) => (
                    <span className={`presence-avatar ${index === 0 ? "is-speaking" : ""}`} key={`${room.id}-${member[1]}`} title={`${member[1]} · ${member[2]}`}>
                      <i>{member[0]}</i><small>{member[1]}</small>
                    </span>
                  ))}
                  <span className="empty-seat">＋</span>
                </div>
                <footer><span>⌁ Context shared</span><b>Enter room →</b></footer>
              </button>
            ))}
            <div className="private-office">
              <span className="eyebrow">PRIVATE OFFICES</span>
              <div><span><Avatar initials="AT" color="#ddf5a1" small /><span><b>Atlas</b><small>Claude Code · RUN-2048</small></span></span><em>FOCUS</em></div>
              <div><span><Avatar initials="RC" color="#d7defa" small /><span><b>Rafael</b><small>Available for drop-in</small></span></span><em className="is-live">OPEN</em></div>
              <div><span><Avatar initials="SE" color="#ffd9c2" small /><span><b>Sentinel</b><small>Reviewing POL-12</small></span></span><em>DND</em></div>
            </div>
          </div>
          <footer className="office-legend"><span><i className="online" /> Online</span><span><i className="talking" /> Speaking</span><span><i className="agent" /> Agent</span><span><i className="dnd" /> DND</span><b>Presence shares work context, never private prompt contents.</b></footer>
        </section>
        <aside className="room-detail">
          <span className="eyebrow">SELECTED ROOM</span>
          <div className="room-detail-title"><span className={`room-monogram room-${selected.tone}`}>{selected.name.slice(0, 1)}</span><span><h2>{selected.name}</h2><p>{selected.type} · {selected.people} inside</p></span></div>
          <div className="room-now"><span>NOW</span><b>{selected.activity}</b><small>Nexus Commerce · context synced</small></div>
          <span className="eyebrow">WHO IS HERE</span>
          <div className="presence-list">
            {selected.members.map((member, index) => (
              <button key={member[1]} onClick={onMessage}>
                <span className={`presence-avatar ${index === 0 ? "is-speaking" : ""}`}><i>{member[0]}</i></span>
                <span><b>{member[1]}</b><small>{member[2]}</small></span>
                <em>{index === 0 ? ")))" : "•••"}</em>
              </button>
            ))}
          </div>
          <div className="room-actions"><button className="primary-button" onClick={() => setMeetingOpen(true)}>Entrar / abrir reunião</button><button className="outline-button" onClick={onMessage}>Abrir chat da sala</button></div>
          <div className="drop-in-note"><b>Drop-in etiquette</b><p>Knock respeita DND e solicita consentimento antes de abrir áudio ou vídeo.</p><button onClick={() => notify(`Knock enviado para ${selected.name}`)}>Knock first</button></div>
        </aside>
      </div>
      {meetingOpen && (
        <div className="modal-backdrop" onClick={() => setMeetingOpen(false)}>
          <div className="meeting-preview" data-testid="meeting-preview" role="dialog" aria-modal="true" aria-label={`Abrir reunião em ${selected.name}`} onClick={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">FUTURE CAPABILITY · MEETING FABRIC</span><h2>Abrir reunião em {selected.name}</h2><p>O contexto da sala entra; o conteúdo da conversa só entra no ledger por decisão explícita.</p></div><button onClick={() => setMeetingOpen(false)}>×</button></header>
            <div className="meeting-stage">
              <div className="meeting-self"><span>RC</span><small>Preview de Rafael</small></div>
              <div className="meeting-participants">{selected.members.slice(0, 3).map((member) => <span key={member[1]}><i>{member[0]}</i><small>{member[1]}</small></span>)}</div>
            </div>
            <div className="media-modes">
              {(["chat", "audio", "video"] as const).map((mode) => <button key={mode} className={mediaMode === mode ? "is-active" : ""} onClick={() => setMediaMode(mode)}><span>{mode === "chat" ? "◌" : mode === "audio" ? "◖" : "▣"}</span><b>{mode}</b><small>{mode === "chat" ? "async + live" : mode === "audio" ? "drop-in" : "meeting room"}</small></button>)}
            </div>
            <div className="meeting-options"><label><input type="checkbox" defaultChecked /> Gerar transcript e minutes</label><label><input type="checkbox" defaultChecked /> Extrair decisions e action items para revisão</label><label><input type="checkbox" /> Gravar áudio/vídeo</label></div>
            <footer><span>Áudio/vídeo: roadmap · chat e presença demonstrados neste protótipo</span><button className="primary-button" onClick={() => { setMeetingOpen(false); notify(`Reunião ${mediaMode} simulada em ${selected.name}`); }}>Simular abertura</button></footer>
          </div>
        </div>
      )}
    </div>
  );
}

function LedgerView({
  notify,
  focusIntentId,
  onFocusConsumed,
  onOpenArtifact,
}: {
  notify: (message: string) => void;
  focusIntentId: string;
  onFocusConsumed: () => void;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const entries = [
    {
      id: "DEC-204",
      type: "DECISION",
      title: "Rollout progressivo 10 → 40 → 100",
      actor: "Rafael · proposed by Atlas",
      time: "09:51",
      reason: "Reduz blast radius sem comprometer sinal estatístico; rollback permanece abaixo de 2 min.",
      hash: "81dc91a4…a921",
      previous: "7e2480bd…139c",
      evidence: "EVD-918 · 6 checks",
      markdown: "# DEC-204 — Rollout progressivo\n\n## Contexto\nO checkout-service está pronto para produção após 248 testes e revisão de segurança.\n\n## Análise\nComparadas as alternativas: deploy imediato, canary 10% e progressão 10 → 40 → 100.\n\n## Decisão\nAdotar progressão 10 → 40 → 100 com janela de 60 minutos.\n\n## Reason why\nReduz blast radius sem comprometer sinal estatístico; rollback permanece abaixo de 2 minutos.\n\n## Evidências\n- PR #482\n- EVD-918\n- Forecast 98,6%\n- Policy POL-12\n\n## Consequência esperada\n100% do tráfego após três gates saudáveis.",
    },
    {
      id: "ACT-881",
      type: "ACTION",
      title: "PR #482 aprovado para merge",
      actor: "Atlas · policy POL-12",
      time: "09:53",
      reason: "Intent permaneceu dentro do escopo aprovado e todos os checks obrigatórios passaram.",
      hash: "9f21ce88…21ba",
      previous: "81dc91a4…a921",
      evidence: "PR #482 · a18f9d2",
      markdown: "# ACT-881 — PR aprovado\n\n## ActionIntent\nmerge aurora/checkout-service#482 @ a18f9d2\n\n## Policy result\nALLOW · POL-12 · risk R2\n\n## Reason why\nO intent permaneceu dentro do escopo aprovado e 6/6 checks passaram.\n\n## Output\nGitHub merge commit a18f9d2.",
    },
    {
      id: "MEM-122",
      type: "MEMORY",
      title: "Promoção de aprendizado do rollout",
      actor: "Luma · reviewed by Camila",
      time: "10:04",
      reason: "O padrão de gate demonstrou utilidade recorrente e não contém dado pessoal ou segredo.",
      hash: "4cb891ad…c090",
      previous: "9f21ce88…21ba",
      evidence: "4 runs · quality 96%",
      markdown: "# MEM-122 — Aprendizado promovido\n\n## Candidate memory\nPara mudanças R2 reversíveis, canary progressivo melhora diagnóstico e limita blast radius.\n\n## Promotion rationale\nValidado em quatro runs, quality score de 96% e sem conteúdo sensível.\n\n## Scope\nTeam memory · Checkout Evolution.",
    },
    {
      id: "REL-184",
      type: "RELEASE",
      title: "v2.18.4 deployed to production",
      actor: "Forge · GitHub Deployments",
      time: "10:12",
      reason: "Todos os gates técnicos e humanos estavam válidos no momento da transição.",
      hash: "bf10a410…88e1",
      previous: "4cb891ad…c090",
      evidence: "in-toto attestation · v2.18.4",
      markdown: "# REL-184 — Production deployment\n\n## Subject\ncheckout-service v2.18.4 · sha256 bf10a410\n\n## Environment\nproduction · 100% traffic\n\n## Authorization\nDEC-204 · signed by Rafael\n\n## Provenance\nPR #482 → commit a18f9d2 → build 781 → deployment 184.",
    },
  ];
  const [selectedId, setSelectedId] = useState("DEC-204");
  const [verified, setVerified] = useState(false);
  const [liveState, setLiveState] = useState<LiveGovernanceState | null>(null);
  const [liveError, setLiveError] = useState("");
  const [livePending, setLivePending] = useState(false);
  const [soloOwnerConfirmation, setSoloOwnerConfirmation] = useState("");
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const focusedIntent = focusIntentId
    ? selectGovernanceIntent(liveState?.intents, focusIntentId)
    : undefined;
  const focusMissing =
    Boolean(focusIntentId) && Boolean(liveState) && !focusedIntent;
  const latestIntent = selectGovernanceIntent(
    liveState?.intents,
    focusIntentId,
  );

  const refreshLiveState = useCallback(
    async (signal?: AbortSignal, intentId = focusIntentId) => {
      const query = intentId
        ? `?${new URLSearchParams({ intentId }).toString()}`
        : "";
      const response = await fetch(`/api/governance/intents${query}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error("live governance unavailable");
      }
      setLiveState((await response.json()) as LiveGovernanceState);
      setLiveError("");
    },
    [focusIntentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    const query = focusIntentId
      ? `?${new URLSearchParams({ intentId: focusIntentId }).toString()}`
      : "";
    fetch(`/api/governance/intents${query}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("live governance unavailable");
        return response.json() as Promise<LiveGovernanceState>;
      })
      .then((state) => {
        setLiveState(state);
        setLiveError("");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name !== "AbortError") {
          setLiveError("Disponível apenas no workspace local autenticado.");
        }
      });
    return () => controller.abort();
  }, [focusIntentId]);

  const runLiveAction = async (
    action: "propose" | "approve" | "execute",
  ) => {
    setLivePending(true);
    try {
      const endpoint =
        action === "propose"
          ? "/api/governance/intents"
          : `/api/governance/intents/${latestIntent?.id}/${action}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers:
          action === "propose"
            ? {
                "content-type": "application/json",
                "idempotency-key": `nexus-ui:${crypto.randomUUID()}`,
              }
            : action === "approve"
              ? { "content-type": "application/json" }
              : undefined,
        body:
          action === "propose"
            ? JSON.stringify({
                summary: "Publish the next governed NexusOS batch",
              })
            : action === "approve"
              ? JSON.stringify({
                  parametersHash: latestIntent?.parametersHash,
                  soloOwnerAcknowledged:
                    latestIntent?.selfApprovalPolicy === "solo_owner" &&
                    soloOwnerConfirmation === "ERASE",
                })
              : undefined,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "operation failed");
      }
      const result = (await response.json().catch(() => ({}))) as {
        receipt?: { kind?: string };
      };
      if (action === "propose") onFocusConsumed();
      window.dispatchEvent(new Event("nexus-attention-changed"));
      if (action === "approve") setSoloOwnerConfirmation("");
      notify(
        action === "propose"
          ? "ActionIntent real proposto e encadeado"
          : action === "approve"
            ? "Aprovação humana vinculada ao payload"
            : result.receipt?.kind === "artifact_erasure"
              ? "Erasure lógica executada com receipt e ledger"
              : "Efeito simulado executado com receipt",
      );
      try {
        if (action === "propose") {
          await refreshLiveState(undefined, "");
        } else {
          await refreshLiveState();
        }
      } catch {
        setLiveError(
          "Operação concluída, mas a leitura ainda não foi atualizada.",
        );
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setLiveError(
        code === "solo_owner_peer_exists"
          ? "Outro aprovador ficou disponível desde a proposta. A autoaprovação foi bloqueada; peça a esse owner/admin para aprovar ou refaça a proposta após expirar."
          : code || "Operação indisponível",
      );
    } finally {
      setLivePending(false);
    }
  };

  return (
    <div className="view-page ledger-page" data-testid="ledger-view">
      <div className="page-heading">
        <div><span className="eyebrow">CRYPTOGRAPHIC DECISION LEDGER</span><h1>Por que fizemos isso?</h1><p>Registro humano em Markdown. Prova verificável em um envelope encadeado.</p></div>
        <div className="heading-actions"><button className="outline-button" onClick={() => notify("Ledger exportado como Markdown + JSONL")}>Export .md + JSONL</button><button className="primary-button compact" onClick={() => setVerified(true)}>✓ Simular verificação</button></div>
      </div>
      <div className="prototype-disclosure"><b>VISION PROTOTYPE</b><span>Entradas, hashes e verificação abaixo são ilustrativos. O produto real calculará SHA-256 sobre JSON canônico, assinará por workload identity e ancorará o root diário no Git.</span></div>
      <section className="live-governance-spine" aria-label="Governance spine real">
        <header>
          <div>
            <span className="eyebrow">REAL FOUNDATION · LOCAL D1</span>
            <h2>ActionIntent → human approval → effect receipt</h2>
            <p>
              Esta faixa já usa persistência, transições de domínio e SHA-256
              reais. O dispatcher executa o simulador ou erasure de artifact
              aprovada; conectores externos continuam roadmap.
            </p>
          </div>
          <span
            className={`live-spine-status ${
              focusMissing
                ? "is-broken"
                : liveState?.verification.valid
                ? "is-healthy"
                : liveState
                  ? "is-broken"
                  : ""
            }`}
          >
            {liveError
              ? "Unavailable"
              : focusMissing
                ? "Target unavailable"
              : !liveState
                ? "Connecting"
                : liveState.verification.valid
                  ? "Chain verified"
                  : "Chain broken"}
          </span>
        </header>
        <div className="live-spine-grid">
          <div>
            <small>LATEST INTENT</small>
            <b>
              {focusMissing
                ? "Focused intent not found"
                : (latestIntent?.status ?? "No intent yet")}
            </b>
            <code>{latestIntent?.id.slice(0, 13) ?? "—"}</code>
          </div>
          <div>
            <small>REAL ENTRIES</small>
            <b>{liveState?.ledger.length ?? 0}</b>
            <code>
              {liveState?.verification.valid
                ? `${liveState.verification.headHash.slice(0, 12)}…`
                : liveState && "sequence" in liveState.verification
                  ? `broken at #${liveState.verification.sequence}`
                  : "genesis"}
            </code>
          </div>
          <div>
            <small>ENFORCEMENT</small>
            <b>Human + payload hash</b>
            <code>expiry · precondition · fencing reais</code>
          </div>
        </div>
        {latestIntent && !focusMissing && (
          <>
            <IntentEvidencePanel
              key={`evidence-${latestIntent.id}`}
              intentId={latestIntent.id}
              intentStatus={latestIntent.status}
              onOpenArtifact={onOpenArtifact}
              onLedgerChanged={() => {
                void refreshLiveState();
              }}
              notify={notify}
            />
            <DecisionPackagePanel
              key={`package-${latestIntent.id}`}
              intentId={latestIntent.id}
              intentStatus={latestIntent.status}
              notify={notify}
            />
          </>
        )}
        {latestIntent?.status === "proposed" &&
          latestIntent.selfApprovalPolicy === "solo_owner" && (
            <label className="solo-owner-ack">
              <span>
                <b>Exceção de único owner</b>
                <small>
                  Nenhum outro owner/admin era elegível na proposta. Digite
                  ERASE; a ausência de um peer será verificada novamente no
                  commit da aprovação.
                </small>
              </span>
              <input
                value={soloOwnerConfirmation}
                onChange={(event) =>
                  setSoloOwnerConfirmation(event.target.value)
                }
                placeholder="ERASE"
                autoComplete="off"
              />
            </label>
          )}
        <div className="live-spine-actions">
          <button
            className="outline-button"
            disabled={livePending}
            onClick={() => runLiveAction("propose")}
          >
            + Propor novo intent
          </button>
          <button
            className="outline-button"
            disabled={
              livePending ||
              focusMissing ||
              latestIntent?.status !== "proposed" ||
              (latestIntent.selfApprovalPolicy === "solo_owner" &&
                soloOwnerConfirmation !== "ERASE")
            }
            onClick={() => runLiveAction("approve")}
          >
            Aprovar como humano
          </button>
          <button
            className="primary-button compact"
            disabled={
              livePending ||
              focusMissing ||
              latestIntent?.status !== "approved"
            }
            onClick={() => runLiveAction("execute")}
          >
            {latestIntent?.actionType === "nexus.artifact.erase_payload"
              ? "Executar erasure"
              : "Executar simulação"}
          </button>
          <button
            className="text-button"
            disabled={livePending}
            onClick={() =>
              refreshLiveState().catch(() =>
                setLiveError("Não foi possível verificar a cadeia."),
              )
            }
          >
            Verificar agora
          </button>
        </div>
        {focusMissing && (
          <p className="live-spine-error" role="alert">
            O ActionIntent vinculado não foi encontrado neste tenant. Nenhuma
            ação foi habilitada.
          </p>
        )}
        {liveError && <p className="live-spine-error">{liveError}</p>}
        <div className="live-chain-events">
          {liveState?.ledger.slice(-4).map((entry) => (
            <span key={entry.id}>
              <small>#{entry.sequence}</small>
              <b>{entry.kind}</b>
              <code>{entry.hash.slice(0, 10)}…</code>
            </span>
          ))}
        </div>
      </section>
      <section className="ledger-health">
        <div><span className="ledger-pulse" /><span><small>SIMULATED CHAIN STATUS</small><b>{verified ? "Simulation refreshed" : "Target state · verified"}</b></span></div>
        <div><small>ENTRIES</small><b>1,284</b></div>
        <div><small>DAILY ROOT</small><code>f981a4…c721</code></div>
        <div><small>ANCHOR</small><b>GitHub commit · 1b7e4a</b></div>
        <div><small>GAPS</small><b>0</b></div>
      </section>
      <div className="ledger-workspace">
        <aside className="ledger-timeline">
          <div className="ledger-filters"><button className="is-active">All</button><button>Decisions</button><button>Actions</button><button>Memory</button></div>
          <span className="ledger-date">TODAY · 25 JUL 2026</span>
          {entries.map((entry) => (
            <button key={entry.id} className={selected.id === entry.id ? "is-selected" : ""} onClick={() => setSelectedId(entry.id)}>
              <i />
              <span><small>{entry.type} · {entry.time}</small><b>{entry.title}</b><em>{entry.actor}</em><code>{entry.hash}</code></span>
            </button>
          ))}
        </aside>
        <section className="ledger-document">
          <header>
            <div><span className="eyebrow">{selected.type} ENTRY</span><h2>{selected.id}</h2></div>
            <span className="verified-badge">TARGET · SIGNED & CHAINED</span>
          </header>
          <pre><code>{selected.markdown}</code></pre>
        </section>
        <aside className="ledger-proof">
          <span className="eyebrow">VERIFICATION ENVELOPE</span>
          <dl>
            <div><dt>Entry ID</dt><dd>{selected.id}</dd></div>
            <div><dt>Actor</dt><dd>{selected.actor}</dd></div>
            <div><dt>Previous hash</dt><dd><code>{selected.previous}</code></dd></div>
            <div><dt>Content hash</dt><dd><code>{selected.hash}</code></dd></div>
            <div><dt>Evidence</dt><dd>{selected.evidence}</dd></div>
            <div><dt>Signature</dt><dd>✓ workload identity</dd></div>
          </dl>
          <div className="reason-panel"><span>REASON WHY</span><p>{selected.reason}</p></div>
          <div className="proof-chain"><span>Markdown</span><i>→</i><span>canonical JSON</span><i>→</i><span>SHA-256</span><i>→</i><b>daily root</b></div>
          <button className="outline-button" onClick={() => notify(`${selected.id}: inclusion proof copiada`)}>Copy inclusion proof</button>
        </aside>
      </div>
      <section className="ledger-principle">
        <b>Sem dependência de blockchain externa.</b>
        <p>O baseline é append-only + hash chain + assinatura + root diário ancorado no Git. Uma transparency log como Rekor pode ser adicionada quando houver necessidade real de verificação por terceiros.</p>
      </section>
    </div>
  );
}

function AgentsView({ onProvider, onRunners, notify }: { onProvider: () => void; onRunners: () => void; notify: (message: string) => void }) {
  const blankAgent: Agent = {
    id: "new-agent",
    initials: "NA",
    name: "",
    role: "Specialist Agent",
    provider: "Anthropic",
    model: "Claude Opus",
    method: "CLI",
    connection: "Claude Code · pool-scl-01",
    status: "Ready",
    project: "Nexus Commerce",
    skills: 6,
    memory: "Projeto",
    color: "#ddf5a1",
  };
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceMutationError, setWorkspaceMutationError] = useState("");
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [reloadWorkspace, setReloadWorkspace] = useState(0);
  const [selectedTeamId, setSelectedTeamId] = useState("team-local-checkout");
  const [agentFilter, setAgentFilter] = useState<"active" | "archived">("active");
  const [agentEditorOpen, setAgentEditorOpen] = useState(false);
  const [teamEditorOpen, setTeamEditorOpen] = useState(false);
  const [draftAgent, setDraftAgent] = useState<Agent>(blankAgent);
  const [draftConnectionId, setDraftConnectionId] = useState("");
  const [draftAutonomy, setDraftAutonomy] = useState<"A0" | "A1" | "A2" | "A3">("A1");
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState({
    id: "",
    name: "",
    mission: "",
    projectId: "",
  });
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/workspace", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error("workspace unavailable");
        }
        return response.json() as Promise<WorkspaceState>;
      })
      .then((state) => {
        setWorkspace(state);
        setWorkspaceError("");
        setSelectedTeamId((current) =>
          state.teams.some((team) => team.id === current)
            ? current
            : state.teams[0]?.id ?? "",
        );
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name !== "AbortError") {
          setWorkspaceError("Não foi possível carregar o workspace persistente.");
        }
      });
    return () => controller.abort();
  }, [reloadWorkspace]);

  useEffect(() => {
    const editorTestId = agentEditorOpen
      ? "agent-editor"
      : teamEditorOpen
        ? "team-editor"
        : null;
    if (!editorTestId) {
      return;
    }
    const dialog = document.querySelector<HTMLElement>(
      `[data-testid="${editorTestId}"]`,
    );
    if (!dialog) {
      return;
    }
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    focusable[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !workspaceSaving) {
        setAgentEditorOpen(false);
        setTeamEditorOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [agentEditorOpen, teamEditorOpen, workspaceSaving]);

  const teams =
    workspace?.teams.map((team) => ({
        id: team.id,
        projectId: team.project_id,
        name: team.name,
        mission: team.mission,
        people: Number(team.human_count),
        agents: Number(team.agent_count),
        status: team.status,
        version: team.version,
      })) ?? [];
  const managedAgents =
    workspace?.agents.map((agent) => {
      const agentTeam = workspace.teams.find((team) =>
        agent.teamIds.includes(team.id),
      );
      const project = workspace.projects.find(
        (candidate) => candidate.id === agentTeam?.project_id,
      );
      const visualStatus: Agent["status"] =
        agent.status === "paused"
          ? "Waiting"
          : agent.connection_status === "attention"
            ? "Review"
            : agent.connection_status === "ready"
              ? "Ready"
              : "Waiting";
      return {
        id: agent.id,
        initials: agent.name.slice(0, 2).toUpperCase(),
        name: agent.name,
        role: agent.role,
        provider: agent.provider ?? "Unassigned",
        model: agent.model,
        method: agent.auth_method === "oauth" ? "OAuth" as const : "CLI" as const,
        connection: agent.connection_label
          ? `${agent.connection_label} · ${agent.connection_status ?? "unknown"}`
          : "Nenhuma conexão atribuída",
        status: visualStatus,
        project: project?.name ?? "Sem projeto",
        skills: 0,
        memory: memoryScopeLabel(agent.memory_scope),
        color: agentColor(agent.id),
        databaseStatus: agent.status,
        autonomy: agent.autonomy_level,
        connectionStatus: agent.connection_status,
        teamIds: agent.teamIds,
      };
    }) ?? [];
  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? teams[0];
  const visibleAgents = managedAgents.filter(
    (agent) =>
      agent.databaseStatus === agentFilter &&
      (!selectedTeam || agent.teamIds.includes(selectedTeam.id)),
  );

  const openNewAgent = () => {
    setDraftAgent({
      ...blankAgent,
      project: selectedTeam?.id ?? "",
    });
    setDraftConnectionId(
      workspace?.connections.find(
        (connection) => connection.status !== "archived",
      )?.id ?? "",
    );
    setDraftAutonomy("A1");
    setWorkspaceMutationError("");
    setEditingAgentId(null);
    setAgentEditorOpen(true);
  };
  const openAgent = (agent: (typeof managedAgents)[number]) => {
    const storedAgent = workspace?.agents.find(
      (candidate) => candidate.id === agent.id,
    );
    setDraftAgent({
      ...agent,
      project: storedAgent?.teamIds[0] ?? selectedTeam?.id ?? "",
    });
    setDraftConnectionId(storedAgent?.connection_id ?? "");
    setDraftAutonomy(storedAgent?.autonomy_level ?? "A1");
    setWorkspaceMutationError("");
    setEditingAgentId(agent.id);
    setAgentEditorOpen(true);
  };
  const openNewTeam = () => {
    setTeamDraft({
      id: "",
      name: "",
      mission: "",
      projectId: workspace?.projects.find((project) => project.status === "active")?.id ?? "",
    });
    setWorkspaceMutationError("");
    setEditingTeamId(null);
    setTeamEditorOpen(true);
  };
  const openTeam = () => {
    if (!selectedTeam) {
      return;
    }
    setTeamDraft({
      id: selectedTeam.id,
      name: selectedTeam.name,
      mission: selectedTeam.mission,
      projectId: selectedTeam.projectId,
    });
    setWorkspaceMutationError("");
    setEditingTeamId(selectedTeam.id);
    setTeamEditorOpen(true);
  };

  const mutateWorkspace = async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
  ) => {
    setWorkspaceSaving(true);
    setWorkspaceMutationError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        const message = workspaceErrorMessage(
          payload.error ?? "workspace_operation_failed",
        );
        setWorkspaceMutationError(message);
        if (response.status === 409) {
          setReloadWorkspace((value) => value + 1);
        }
        return false;
      }
      window.dispatchEvent(new Event("nexus-workspace-changed"));
      setReloadWorkspace((value) => value + 1);
      return true;
    } catch {
      setWorkspaceMutationError("A operação não chegou ao workspace local.");
      return false;
    } finally {
      setWorkspaceSaving(false);
    }
  };

  const saveAgent = async () => {
    const storedAgent = workspace?.agents.find(
      (agent) => agent.id === editingAgentId,
    );
    const succeeded = editingAgentId && storedAgent
      ? await mutateWorkspace(`/api/workspace/agents/${editingAgentId}`, "PATCH", {
          expectedVersion: storedAgent.version,
          name: draftAgent.name,
          role: draftAgent.role,
          model: draftAgent.model,
          connectionId: draftConnectionId || null,
          memoryScope: memoryScopeValue(draftAgent.memory),
          autonomyLevel: draftAutonomy,
        })
      : await mutateWorkspace("/api/workspace/agents", "POST", {
          teamId: draftAgent.project,
          connectionId: draftConnectionId || null,
          slug: workspaceSlug(draftAgent.name),
          name: draftAgent.name,
          role: draftAgent.role,
          model: draftAgent.model,
          memoryScope: memoryScopeValue(draftAgent.memory),
          autonomyLevel: draftAutonomy,
        });
    if (succeeded) {
      setAgentEditorOpen(false);
      notify(editingAgentId ? `${draftAgent.name} atualizado no D1` : `${draftAgent.name} criado no D1`);
    }
  };

  const toggleAgentArchive = async (
    agent: (typeof managedAgents)[number],
  ) => {
    const storedAgent = workspace?.agents.find(
      (candidate) => candidate.id === agent.id,
    );
    if (!storedAgent) {
      return;
    }
    const nextStatus =
      storedAgent.status === "archived" ? "active" : "archived";
    const succeeded = await mutateWorkspace(
      `/api/workspace/agents/${agent.id}`,
      "PATCH",
      { expectedVersion: storedAgent.version, status: nextStatus },
    );
    if (succeeded) {
      notify(
        nextStatus === "archived"
          ? `${agent.name} arquivado com histórico preservado`
          : `${agent.name} restaurado`,
      );
    }
  };

  const saveTeam = async () => {
    const storedTeam = workspace?.teams.find(
      (team) => team.id === editingTeamId,
    );
    const succeeded = editingTeamId && storedTeam
      ? await mutateWorkspace(`/api/workspace/teams/${editingTeamId}`, "PATCH", {
          expectedVersion: storedTeam.version,
          name: teamDraft.name,
          mission: teamDraft.mission,
        })
      : await mutateWorkspace("/api/workspace/teams", "POST", {
          projectId: teamDraft.projectId,
          slug: workspaceSlug(teamDraft.name),
          name: teamDraft.name,
          mission: teamDraft.mission,
        });
    if (succeeded) {
      setTeamEditorOpen(false);
      notify(editingTeamId ? `${teamDraft.name} atualizado no D1` : `${teamDraft.name} criado no D1`);
    }
  };

  const toggleTeamArchive = async () => {
    const storedTeam = workspace?.teams.find(
      (team) => team.id === editingTeamId,
    );
    if (!storedTeam) {
      return;
    }
    const nextStatus =
      storedTeam.status === "archived" ? "active" : "archived";
    const succeeded = await mutateWorkspace(
      `/api/workspace/teams/${storedTeam.id}`,
      "PATCH",
      { expectedVersion: storedTeam.version, status: nextStatus },
    );
    if (succeeded) {
      setTeamEditorOpen(false);
      notify(
        nextStatus === "archived"
          ? `${storedTeam.name} arquivado`
          : `${storedTeam.name} restaurado`,
      );
    }
  };

  return (
    <div
      className="view-page agents-page"
      data-testid="agents-view"
      aria-busy={!workspace && !workspaceError}
    >
      <div className="page-heading">
        <div><span className="eyebrow">HYBRID TEAM RUNTIME</span><h1>Times & agentes</h1><p>Crie, configure, mova e arquive responsabilidades com autoridade explícita.</p></div>
        <div className="heading-actions"><button className="outline-button" onClick={onRunners}>⌁ Runners</button><button className="outline-button" data-testid="open-team-editor" disabled={!workspace || workspaceSaving} onClick={openNewTeam}>＋ Novo time</button><button className="primary-button compact" data-testid="open-agent-editor" disabled={!workspace || workspaceSaving || selectedTeam?.status === "archived"} onClick={openNewAgent}>＋ Novo agente</button></div>
      </div>
      {workspaceError && (
        <section className="workspace-state-banner is-error" role="alert">
          <span><b>Workspace indisponível</b><small>{workspaceError}</small></span>
          <button onClick={() => setReloadWorkspace((value) => value + 1)}>Tentar novamente</button>
        </section>
      )}
      {!workspace && !workspaceError && (
        <section className="workspace-state-banner is-loading">
          <span><b>Carregando estado persistente…</b><small>Projetos, times, agentes e conexões em D1</small></span>
        </section>
      )}
      {workspace && (
        <div className="real-data-disclosure">
          <b>REAL · LOCAL D1</b>
          <span>Este diretório vem da API persistente. Skills, qualidade e execução do agente permanecem roadmap.</span>
        </div>
      )}
      <section className="team-selector">
        {teams.map((team) => (
          <button key={team.id} className={selectedTeamId === team.id ? "is-selected" : ""} onClick={() => setSelectedTeamId(team.id)}>
            <span><i>{team.name.slice(0, 1)}</i><span><small>{team.status.toUpperCase()} · v{team.version}</small><b>{team.name}</b></span></span>
            <p>{team.mission}</p>
            <footer><span>{team.people} humans</span><span>{team.agents} agents</span><em>→</em></footer>
          </button>
        ))}
        <button className="new-team-card" onClick={openNewTeam}><span>＋</span><b>Criar time</b><small>Missão, membros e policies</small></button>
      </section>
      {selectedTeam ? (
        <section className="team-overview">
          <div><span className="section-number">01</span><span><span className="eyebrow">{selectedTeam.name.toUpperCase()}</span><h2>{selectedTeam.people} humans + {selectedTeam.agents} agents</h2><p>{selectedTeam.mission}</p></span></div>
          <div className="team-capacity">
            <span><b>—</b>capacity · roadmap</span>
            <span><b>—</b>quality · roadmap</span>
            <span><b>—</b>cost · roadmap</span>
            <button onClick={openTeam}>Editar time</button>
          </div>
        </section>
      ) : workspace ? (
        <section className="workspace-empty-state">
          <span>01</span><div><h2>Seu primeiro time começa aqui</h2><p>Crie um time híbrido para atribuir humanos e agentes a uma missão.</p></div><button onClick={openNewTeam}>＋ Criar time</button>
        </section>
      ) : null}
      <div className="directory-heading">
        <div><span className="eyebrow">AGENT ASSIGNMENTS</span><h2>Responsabilidades configuradas</h2></div>
        <div>
          <button className={agentFilter === "active" ? "is-active" : ""} onClick={() => setAgentFilter("active")}>Active {managedAgents.filter((agent) => agent.databaseStatus === "active").length}</button>
          <button className={agentFilter === "archived" ? "is-active" : ""} onClick={() => setAgentFilter("archived")}>Archived {managedAgents.filter((agent) => agent.databaseStatus === "archived").length}</button>
        </div>
      </div>
      <div className="agent-directory">
        {visibleAgents.map((agent) => (
          <article className="directory-card" key={agent.id}>
            <div className="directory-top">
              <Avatar initials={agent.initials} color={agent.color} />
              <span className="state-cell"><StatusDot status={agent.status} />{agent.status}</span>
            </div>
            <span className="member-type">AGENT ASSIGNMENT · {agent.project}</span>
            <h3>{agent.name}</h3>
            <p>{agent.role}</p>
            <button className="model-connection" onClick={onProvider}>
              <span className={`provider-method provider-${agent.method.toLowerCase()}`}>{agent.method}</span>
              <span><b>{agent.model}</b><small>{agent.connection}</small></span>
              <i>→</i>
            </button>
            <div className="agent-config-grid">
              <span><small>SKILLS</small><b>Roadmap</b></span>
              <span><small>MEMORY</small><b>{agent.memory}</b></span>
              <span><small>AUTONOMY</small><b>{agent.autonomy}</b></span>
              <span><small>CONNECTION</small><b>{agent.connectionStatus ?? "none"}</b></span>
            </div>
            <footer>
              <button onClick={() => openAgent(agent)}>Editar</button>
              <button onClick={() => notify(`${agent.name} Agent Room aberto`)}>Agent Room</button>
              <button className="archive-action" disabled={workspaceSaving} onClick={() => toggleAgentArchive(agent)}>{agent.databaseStatus === "archived" ? "Restaurar" : "Arquivar"}</button>
            </footer>
          </article>
        ))}
        <button className="agent-add-card" onClick={openNewAgent}><span>＋</span><b>Novo agent assignment</b><small>Role · model · tools · memory · authority</small></button>
      </div>
      {workspace && selectedTeam && visibleAgents.length === 0 && (
        <p className="directory-empty">Nenhum agente {agentFilter === "active" ? "ativo" : "arquivado"} neste time.</p>
      )}
      {agentEditorOpen && (
        <div className="modal-backdrop" onClick={() => setAgentEditorOpen(false)}>
          <form className="entity-editor" data-testid="agent-editor" role="dialog" aria-modal="true" aria-label={editingAgentId ? `Editar ${draftAgent.name}` : "Novo agente"} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void saveAgent(); }}>
            <header><div><span className="eyebrow">AGENT STUDIO</span><h2>{editingAgentId ? `Editar ${draftAgent.name}` : "Novo agente"}</h2><p>Um agent assignment é uma responsabilidade configurada, não apenas um prompt.</p></div><button type="button" onClick={() => setAgentEditorOpen(false)}>×</button></header>
            <div className="editor-grid">
              <label>Nome<input value={draftAgent.name} onChange={(event) => setDraftAgent({ ...draftAgent, name: event.target.value })} placeholder="Ex. Scout" /></label>
              <label>Role<input value={draftAgent.role} onChange={(event) => setDraftAgent({ ...draftAgent, role: event.target.value })} /></label>
              <label>Time<select value={draftAgent.project} disabled={Boolean(editingAgentId)} onChange={(event) => setDraftAgent({ ...draftAgent, project: event.target.value })}>{teams.filter((team) => team.status !== "archived").map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
              <label>Conexão<select value={draftConnectionId} onChange={(event) => setDraftConnectionId(event.target.value)}><option value="">Sem conexão</option>{workspace?.connections.filter((connection) => connection.status !== "archived").map((connection) => <option key={connection.id} value={connection.id}>{connection.provider} · {connection.label} · {connection.auth_method.toUpperCase()} · {connection.status}</option>)}</select></label>
              <label>Modelo<input value={draftAgent.model} onChange={(event) => setDraftAgent({ ...draftAgent, model: event.target.value })} /></label>
              <label>Autonomy<select value={draftAutonomy} onChange={(event) => setDraftAutonomy(event.target.value as typeof draftAutonomy)}><option>A0</option><option>A1</option><option>A2</option><option>A3</option></select></label>
              <label>Skills<input value="Roadmap · próximo módulo" disabled /></label>
              <label>Memory scope<select value={draftAgent.memory} onChange={(event) => setDraftAgent({ ...draftAgent, memory: event.target.value })}><option>Run</option><option>Projeto</option><option>Projeto + time</option><option>Episódica governada</option></select></label>
            </div>
            {workspaceMutationError && <p className="workspace-form-error" role="alert">{workspaceMutationError}</p>}
            <section className="authority-editor"><span className="eyebrow">AUTHORITY POLICY</span><div><label><input type="checkbox" defaultChecked /> Pode propor e criar artifacts</label><label><input type="checkbox" defaultChecked /> Pode executar tools R1/R2</label><label><input type="checkbox" /> Pode aprovar o próprio trabalho</label></div><p>R3/R4, gasto fora do budget ou mudança de escopo sempre escalam para um humano accountable.</p></section>
            <footer><button type="button" className="text-button" disabled={workspaceSaving} onClick={() => setAgentEditorOpen(false)}>Cancelar</button><button className="primary-button" data-testid="save-agent" type="submit" disabled={workspaceSaving}>{workspaceSaving ? "Salvando…" : editingAgentId ? "Salvar alterações" : "Criar agente"}</button></footer>
          </form>
        </div>
      )}
      {teamEditorOpen && (
        <div className="modal-backdrop" onClick={() => setTeamEditorOpen(false)}>
          <form className="entity-editor compact-editor" data-testid="team-editor" role="dialog" aria-modal="true" aria-label={editingTeamId ? "Editar time" : "Novo time híbrido"} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void saveTeam(); }}>
            <header><div><span className="eyebrow">TEAM STUDIO</span><h2>{editingTeamId ? "Editar time" : "Novo time híbrido"}</h2><p>Missão, composição, budget e policies compartilhadas.</p></div><button type="button" onClick={() => setTeamEditorOpen(false)}>×</button></header>
            <label>Nome do time<input value={teamDraft.name} onChange={(event) => setTeamDraft({ ...teamDraft, name: event.target.value })} placeholder="Ex. Growth Intelligence" /></label>
            <label>Missão<textarea value={teamDraft.mission} onChange={(event) => setTeamDraft({ ...teamDraft, mission: event.target.value })} placeholder="Resultado pelo qual este time é accountable" /></label>
            <div className="editor-grid"><label>Projeto<select value={teamDraft.projectId} disabled={Boolean(editingTeamId)} onChange={(event) => setTeamDraft({ ...teamDraft, projectId: event.target.value })}>{workspace?.projects.filter((project) => project.status === "active").map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Policy bundle<select><option>Software Delivery · A2</option><option>Research · A1</option></select></label></div>
            {workspaceMutationError && <p className="workspace-form-error" role="alert">{workspaceMutationError}</p>}
            <footer>{editingTeamId && <button type="button" className="text-button danger-text" disabled={workspaceSaving} onClick={() => void toggleTeamArchive()}>{selectedTeam?.status === "archived" ? "Restaurar time" : "Arquivar time"}</button>}<button type="button" className="text-button" disabled={workspaceSaving} onClick={() => setTeamEditorOpen(false)}>Cancelar</button><button className="primary-button" type="submit" disabled={workspaceSaving}>{workspaceSaving ? "Salvando…" : "Salvar time"}</button></footer>
          </form>
        </div>
      )}
    </div>
  );
}

function memoryScopeLabel(scope: WorkspaceState["agents"][number]["memory_scope"]) {
  return {
    run: "Run",
    project: "Projeto",
    team: "Projeto + time",
    governed_episodic: "Episódica governada",
  }[scope];
}

function agentColor(id: string) {
  const palette = ["#ddf5a1", "#c8e7ff", "#ead7ff", "#ffd7bd", "#cdeed9"];
  const seed = Array.from(id).reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  return palette[seed % palette.length];
}

function memoryScopeValue(label: string): WorkspaceState["agents"][number]["memory_scope"] {
  if (label === "Run") return "run";
  if (label === "Projeto + time") return "team";
  if (label === "Episódica governada") return "governed_episodic";
  return "project";
}

function workspaceSlug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function workspaceErrorMessage(code: string) {
  const messages: Record<string, string> = {
    version_conflict:
      "Este registro mudou em outra sessão. Os dados foram recarregados; revise antes de salvar novamente.",
    duplicate_entity:
      "Já existe um registro com este nome lógico neste escopo.",
    team_has_active_members:
      "Arquive ou mova os membros ativos antes de arquivar este time.",
    project_has_active_teams:
      "Arquive os times ativos antes de arquivar este projeto.",
    project_has_active_objectives:
      "Conclua ou cancele os objetivos ativos antes de arquivar este projeto.",
    project_has_active_work_items:
      "Conclua ou cancele os itens de trabalho ativos antes de arquivar este projeto.",
    objective_has_active_work_items:
      "Conclua ou cancele os itens de trabalho ativos antes de encerrar este objetivo.",
    invalid_status_transition:
      "Esta transição não faz parte do fluxo de trabalho permitido.",
    connection_has_active_agents:
      "Esta conexão ainda está atribuída a agentes ativos.",
    invalid_reference:
      "O projeto, time ou conexão selecionado não está mais ativo.",
    invalid_name: "Informe um nome entre 1 e 80 caracteres.",
    invalid_role: "Informe uma responsabilidade válida.",
    invalid_model: "Informe o modelo atribuído ao agente.",
    invalid_mission: "Descreva a missão do time.",
    invalid_slug: "O nome precisa gerar um identificador válido.",
  };
  return messages[code] ?? "Não foi possível concluir a operação.";
}

function CommandPalette({
  onClose,
  onNavigate,
  organizationName,
}: {
  onClose: () => void;
  onNavigate: (view: View) => void;
  organizationName: string;
}) {
  const commands = [
    ["Abrir Projetos", "project", "▦"],
    ["Abrir Mensagens", "messages", "◌"],
    ["Ver Team Rooms", "rooms", "⌗"],
    ["Revisar Inbox", "inbox", "◇"],
    ["Ver outputs persistidos", "outputs", "▤"],
    ["Gerenciar times e agentes", "agents", "◎"],
    ["Ver catálogo declarado de provedores", "providers", "⌁"],
    ["Gerenciar runners locais", "runners", "⌁"],
    ["Abrir Decision Ledger", "ledger", "≋"],
  ] as const;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="command-palette" onClick={(event) => event.stopPropagation()}>
        <div className="command-input">
          <span>⌕</span>
          <input autoFocus placeholder="Pergunte, navegue ou acione…" aria-label="Comando Nexus" />
          <kbd>ESC</kbd>
        </div>
        <div className="command-context">
          <span>CONTEXT</span>
          <b>{displayLabel(organizationName, "Workspace")} / Todos os projetos</b>
        </div>
        <div className="command-list">
          <span>SUGESTÕES</span>
          {commands.map((command) => (
            <button key={command[0]} onClick={() => { onNavigate(command[1]); onClose(); }}>
              <i>{command[2]}</i><span>{command[0]}</span><kbd>↵</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function readWorkspaceState(payload: unknown): WorkspaceState | null {
  const bootstrap = readWorkspaceBootstrap(payload);
  if (
    !bootstrap ||
    typeof payload !== "object" ||
    payload === null ||
    !("projects" in payload) ||
    !Array.isArray(payload.projects) ||
    !("teams" in payload) ||
    !Array.isArray(payload.teams) ||
    !("connections" in payload) ||
    !Array.isArray(payload.connections) ||
    !("agents" in payload) ||
    !Array.isArray(payload.agents) ||
    !("objectives" in payload) ||
    !Array.isArray(payload.objectives) ||
    !("workItems" in payload) ||
    !Array.isArray(payload.workItems)
  ) {
    return null;
  }
  return { ...payload, ...bootstrap } as WorkspaceState;
}

async function fetchWorkspaceState(signal?: AbortSignal): Promise<WorkspaceState> {
  const response = await fetch("/api/workspace", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("workspace_unavailable");
  const workspace = readWorkspaceState(await response.json());
  if (!workspace) throw new Error("workspace_contract_invalid");
  return workspace;
}

function WorkspaceBootState({
  status,
  message,
  onRetry,
}: {
  status: "loading" | "error";
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <main
      className="onboarding-shell"
      data-testid={status === "loading" ? "workspace-loading" : "workspace-error"}
    >
      <header className="onboarding-header">
        <span className="brand-button">
          <BrandMark />
          <span>
            <b>NexusOS</b>
            <small>Hybrid operations</small>
          </span>
        </span>
      </header>
      <section
        className={`workspace-state-banner ${
          status === "loading" ? "is-loading" : "is-error"
        }`}
        role={status === "loading" ? "status" : "alert"}
      >
        <span>
          <b>
            {status === "loading"
              ? "Carregando seu workspace…"
              : "Não foi possível abrir o workspace"}
          </b>
          <small>
            {status === "loading"
              ? "Confirmando identidade e estado da configuração inicial."
              : message ??
                "A configuração não será presumida. Tente consultar novamente."}
          </small>
        </span>
        {status === "error" && onRetry && (
          <button type="button" onClick={onRetry}>
            Tentar novamente
          </button>
        )}
      </section>
    </main>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("project");
  const [commandOpen, setCommandOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [workspaceSummary, setWorkspaceSummary] =
    useState<WorkspaceState | null>(null);
  const [workspaceLoadStatus, setWorkspaceLoadStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [conversationCount, setConversationCount] = useState<number | null>(
    null,
  );
  const [attentionCount, setAttentionCount] = useState<number | null>(null);
  const realtimeStatusRef = useRef("probing");
  const [focusedIntentId, setFocusedIntentId] = useState("");
  const [messageFocusId, setMessageFocusId] = useState("");
  const [artifactFocusWorkItemId, setArtifactFocusWorkItemId] = useState("");
  const [artifactFocusArtifactId, setArtifactFocusArtifactId] = useState("");
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>(
    {},
  );
  const clearFocusedIntent = useCallback(() => setFocusedIntentId(""), []);
  const clearArtifactFocus = useCallback(
    () => setArtifactFocusWorkItemId(""),
    [],
  );
  const clearArtifactLinkFocus = useCallback(
    () => setArtifactFocusArtifactId(""),
    [],
  );
  const refreshWorkspace = useCallback(
    async (signal?: AbortSignal): Promise<WorkspaceState> => {
      const workspace = await fetchWorkspaceState(signal);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      setWorkspaceSummary(workspace);
      setWorkspaceLoadStatus("ready");
      setWorkspaceLoadError("");
      return workspace;
    },
    [],
  );
  const retryWorkspace = useCallback(() => {
    setWorkspaceLoadStatus("loading");
    setWorkspaceLoadError("");
    void refreshWorkspace().catch(() => {
      setWorkspaceSummary(null);
      setWorkspaceLoadStatus("error");
      setWorkspaceLoadError(
        "A API não retornou um workspace autenticado no contrato esperado.",
      );
    });
  }, [refreshWorkspace]);
  const workspaceOperational =
    workspaceLoadStatus === "ready" &&
    workspaceSummary?.setupRequired === false;
  const navigate = useCallback((nextView: View) => {
    if (nextView !== "ledger") setFocusedIntentId("");
    if (nextView === "messages") setMessageFocusId("");
    if (nextView !== "outputs") {
      setArtifactFocusWorkItemId("");
      setArtifactFocusArtifactId("");
      const url = new URL(window.location.href);
      if (url.searchParams.has("artifact")) {
        url.searchParams.delete("artifact");
        window.history.replaceState(null, "", url);
      }
    }
    setView(nextView);
  }, []);

  useEffect(() => {
    const artifactId = new URLSearchParams(window.location.search).get(
      "artifact",
    );
    if (!artifactId || artifactId.length > 100) return;
    const timer = window.setTimeout(() => {
      setArtifactFocusArtifactId(artifactId);
      setView("outputs");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [view]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const loadWorkspaceSummary = () => {
      void refreshWorkspace(controller.signal).catch((error: unknown) => {
        if (
          !active ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return;
        }
        setWorkspaceSummary(null);
        setWorkspaceLoadStatus("error");
        setWorkspaceLoadError(
          "A API não retornou um workspace autenticado no contrato esperado.",
        );
      });
    };
    loadWorkspaceSummary();
    window.addEventListener("nexus-workspace-changed", loadWorkspaceSummary);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener(
        "nexus-workspace-changed",
        loadWorkspaceSummary,
      );
    };
  }, [refreshWorkspace]);

  useEffect(() => {
    const handleRealtimeStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string }>).detail;
      if (detail?.status) realtimeStatusRef.current = detail.status;
    };
    window.addEventListener("nexus-realtime-status", handleRealtimeStatus);
    return () =>
      window.removeEventListener(
        "nexus-realtime-status",
        handleRealtimeStatus,
      );
  }, []);

  useEffect(() => {
    if (!workspaceOperational) return;
    if (view === "inbox") return;
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    const controller = new AbortController();
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(poll, delay);
    };
    const poll = async () => {
      if (!active) return;
      if (document.visibilityState === "hidden") {
        schedule(30_000);
        return;
      }
      try {
        const response = await fetch("/api/attention?view=count", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("attention unavailable");
        const state = (await response.json()) as { count: number };
        if (!active) return;
        setAttentionCount(state.count);
        failures = 0;
        schedule(
          realtimeStatusRef.current === "live" ? 60_000 : 15_000,
        );
      } catch (countError) {
        if (
          !active ||
          (countError instanceof Error && countError.name === "AbortError")
        ) {
          return;
        }
        failures += 1;
        schedule(Math.min(120_000, 15_000 * 2 ** failures));
      }
    };
    const refreshNow = () => {
      window.clearTimeout(timer);
      void poll();
    };
    void poll();
    window.addEventListener("nexus-attention-changed", refreshNow);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener(
        "nexus-attention-changed",
        refreshNow,
      );
    };
  }, [view, workspaceOperational]);

  useEffect(() => {
    if (!workspaceOperational) return;
    let active = true;
    const loadConversationCount = () => {
      fetch("/api/conversations", { cache: "no-store" })
        .then((response) => {
          if (!response.ok) {
            throw new Error("conversations unavailable");
          }
          return response.json() as Promise<{ conversations: unknown[] }>;
        })
        .then((state) => {
          if (active) setConversationCount(state.conversations.length);
        })
        .catch(() => {
          if (active) setConversationCount(null);
        });
    };
    loadConversationCount();
    window.addEventListener(
      "nexus-conversations-changed",
      loadConversationCount,
    );
    return () => {
      active = false;
      window.removeEventListener(
        "nexus-conversations-changed",
        loadConversationCount,
      );
    };
  }, [workspaceOperational]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const updateMessageDraft = useCallback(
    (conversationId: string, value: string) => {
      setMessageDrafts((current) => {
        if (!value) {
          if (!(conversationId in current)) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        }
        if (current[conversationId] === value) return current;
        return { ...current, [conversationId]: value };
      });
    },
    [],
  );

  const currentContent = (() => {
    if (view === "messages") return <MessagesView onProject={() => setView("project")} onOutput={() => setView("outputs")} notify={notify} workspace={workspaceSummary} drafts={messageDrafts} onDraftChange={updateMessageDraft} initialConversationId={messageFocusId} onInitialConversationConsumed={() => setMessageFocusId("")} />;
    if (view === "rooms") return <RoomsView onMessage={(conversationId) => { setMessageFocusId(conversationId); setView("messages"); }} notify={notify} />;
    if (view === "project")
      return (
        <ProjectView
          notify={notify}
          onOpenOutputs={(workItemId) => {
            setArtifactFocusWorkItemId(workItemId);
            setView("outputs");
          }}
        />
      );
    if (view === "inbox")
      return (
        <PersistentAttentionView
          notify={notify}
          onCountChange={setAttentionCount}
          onGovernance={(intentId) => {
            setFocusedIntentId(intentId);
            setView("ledger");
          }}
        />
      );
    if (view === "outputs")
      return (
        <PersistentOutputsView
          workspace={workspaceSummary}
          initialWorkItemId={artifactFocusWorkItemId}
          onInitialWorkItemConsumed={clearArtifactFocus}
          initialArtifactId={artifactFocusArtifactId}
          onInitialArtifactConsumed={clearArtifactLinkFocus}
          onErasureIntentProposed={(intentId) => {
            setFocusedIntentId(intentId);
            setView("ledger");
          }}
          notify={notify}
        />
      );
    if (view === "agents") return <AgentsView onProvider={() => setView("providers")} onRunners={() => setView("runners")} notify={notify} />;
    if (view === "runners") return <RunnersView notify={notify} />;
    if (view === "providers") return <ProvidersView />;
    if (view === "ledger")
      return (
        <LedgerView
          notify={notify}
          focusIntentId={focusedIntentId}
          onFocusConsumed={clearFocusedIntent}
          onOpenArtifact={(artifactId) => {
            setArtifactFocusArtifactId(artifactId);
            setView("outputs");
          }}
        />
      );
    return null;
  })();

  if (workspaceLoadStatus === "loading") {
    return <WorkspaceBootState status="loading" />;
  }
  if (workspaceLoadStatus === "error" || !workspaceSummary) {
    return (
      <WorkspaceBootState
        status="error"
        message={workspaceLoadError}
        onRetry={retryWorkspace}
      />
    );
  }
  if (workspaceSummary.setupRequired) {
    return (
      <Onboarding
        reloadWorkspace={refreshWorkspace}
        onComplete={(workspace) => {
          setWorkspaceSummary(workspace);
          setWorkspaceLoadStatus("ready");
          setWorkspaceLoadError("");
          setCommandOpen(false);
          setView("project");
        }}
      />
    );
  }

  return (
    <RealtimeProvider>
      <PresenceProvider>
        <div className="app-shell">
      <Sidebar
        view={view}
        onNavigate={navigate}
        workspace={workspaceSummary}
        conversationCount={conversationCount}
        attentionCount={attentionCount}
      />
      <div className="app-main">
        <AppHeader
          onCommand={() => setCommandOpen(true)}
          onProvider={() => navigate("providers")}
          currentPrincipal={workspaceSummary.currentPrincipal}
        />
        {currentContent}
      </div>
      <nav className="mobile-nav">
        {mobileNavIds.map((id) => navItems.find((item) => item.id === id)).filter((item): item is (typeof navItems)[number] => Boolean(item)).map((item) => (
          <button key={item.id} className={view === item.id ? "is-active" : ""} onClick={() => navigate(item.id)}>
            <i>{item.icon}</i><span>{item.label}</span>
          </button>
        ))}
      </nav>
      {commandOpen && (
        <CommandPalette
          onClose={() => setCommandOpen(false)}
          onNavigate={navigate}
          organizationName={workspaceSummary.organization.name}
        />
      )}
        {toast && <div className="toast">{toast}<span>✓</span></div>}
        </div>
      </PresenceProvider>
    </RealtimeProvider>
  );
}
