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
import { PresenceProvider } from "./presence-client";
import { RealtimeProvider, useRealtime } from "./realtime-client";
import { selectGovernanceIntent } from "@/src/domain/governance";

type View =
  | "welcome"
  | "today"
  | "messages"
  | "rooms"
  | "project"
  | "inbox"
  | "outputs"
  | "releases"
  | "agents"
  | "automations"
  | "providers"
  | "ledger";

type VisionProject = {
  id: string;
  name: string;
  company: string;
  color: string;
  accent: string;
  progress: number;
  health: "On track" | "At risk" | "Needs attention";
  objective: string;
  activeAgents: number;
  decisions: number;
  trend: string;
};

type Agent = {
  id: string;
  initials: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  method: "OAuth" | "CLI";
  connection: string;
  status: "Running" | "Ready" | "Waiting" | "Review";
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

type WorkspaceState = {
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

const visionProjects: VisionProject[] = [
  {
    id: "nexus-commerce",
    name: "Nexus Commerce",
    company: "Aurora Labs",
    color: "#e7f6c7",
    accent: "#4f6818",
    progress: 72,
    health: "On track",
    objective: "Lançar checkout autônomo e reduzir abandono para 31%",
    activeAgents: 4,
    decisions: 2,
    trend: "+12%",
  },
  {
    id: "orion-data",
    name: "Orion Data",
    company: "Aurora Labs",
    color: "#e9e5ff",
    accent: "#5946a5",
    progress: 58,
    health: "At risk",
    objective: "Migrar a camada analítica sem interromper relatórios",
    activeAgents: 3,
    decisions: 3,
    trend: "-4%",
  },
  {
    id: "meridian-ops",
    name: "Meridian Ops",
    company: "Meridian Partners",
    color: "#fee8d7",
    accent: "#9d4b14",
    progress: 89,
    health: "On track",
    objective: "Automatizar o fechamento operacional de 6 unidades",
    activeAgents: 5,
    decisions: 1,
    trend: "+18%",
  },
];

const agents: Agent[] = [
  {
    id: "atlas",
    initials: "AT",
    name: "Atlas",
    role: "Engineering Lead",
    provider: "Anthropic",
    model: "Claude Opus",
    method: "CLI",
    connection: "Claude Code · pool-scl-01",
    status: "Running",
    project: "Nexus Commerce",
    skills: 12,
    memory: "Projeto + time",
    color: "#ddf5a1",
  },
  {
    id: "luma",
    initials: "LU",
    name: "Luma",
    role: "Product Analyst",
    provider: "OpenAI",
    model: "GPT-5",
    method: "OAuth",
    connection: "Conta OpenAI · válida 21d",
    status: "Ready",
    project: "Nexus Commerce",
    skills: 8,
    memory: "Projeto",
    color: "#d8d1ff",
  },
  {
    id: "sentinel",
    initials: "SE",
    name: "Sentinel",
    role: "Security Reviewer",
    provider: "Anthropic",
    model: "Claude Sonnet",
    method: "OAuth",
    connection: "Anthropic · válida 13d",
    status: "Review",
    project: "Orion Data",
    skills: 10,
    memory: "Episódica governada",
    color: "#ffd9c2",
  },
  {
    id: "forge",
    initials: "FG",
    name: "Forge",
    role: "Implementation Agent",
    provider: "OpenAI",
    model: "Codex",
    method: "CLI",
    connection: "Codex CLI · pool-scl-02",
    status: "Waiting",
    project: "Meridian Ops",
    skills: 15,
    memory: "Run + projeto",
    color: "#cfeaec",
  },
];

const navItems: Array<{ id: View; label: string; icon: string; group: "OPERAR" | "ENTREGAR" | "GOVERNAR" }> = [
  { id: "today", label: "Today", icon: "⌂", group: "OPERAR" },
  { id: "messages", label: "Mensagens", icon: "◌", group: "OPERAR" },
  { id: "rooms", label: "Team Rooms", icon: "⌗", group: "OPERAR" },
  { id: "inbox", label: "Inbox", icon: "◇", group: "OPERAR" },
  { id: "project", label: "Projetos", icon: "▦", group: "ENTREGAR" },
  { id: "outputs", label: "Outputs", icon: "▤", group: "ENTREGAR" },
  { id: "releases", label: "Releases", icon: "↗", group: "ENTREGAR" },
  { id: "agents", label: "Times & agentes", icon: "◎", group: "GOVERNAR" },
  { id: "automations", label: "Automações", icon: "↻", group: "GOVERNAR" },
  { id: "providers", label: "Provedores", icon: "⌁", group: "GOVERNAR" },
  { id: "ledger", label: "Decision Ledger", icon: "≋", group: "GOVERNAR" },
];

const mobileNavIds: View[] = ["today", "messages", "rooms", "inbox", "project"];

const providers = [
  {
    name: "OpenAI",
    method: "OAuth",
    detail: "Conta de Rafael · 4 agents",
    status: "Conectado",
    tone: "mint",
  },
  {
    name: "Anthropic",
    method: "OAuth",
    detail: "Workspace Aurora · 2 agents",
    status: "Conectado",
    tone: "violet",
  },
  {
    name: "Claude Code",
    method: "CLI",
    detail: "pool-scl-01 · heartbeat 12s",
    status: "Saudável",
    tone: "orange",
  },
  {
    name: "Codex CLI",
    method: "CLI",
    detail: "pool-scl-02 · heartbeat 7s",
    status: "Saudável",
    tone: "cyan",
  },
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

function ProgressBar({
  value,
  color = "#a8db43",
}: {
  value: number;
  color?: string;
}) {
  return (
    <span className="progress-track" aria-label={`${value}% concluído`}>
      <span
        className="progress-fill"
        style={{ width: `${value}%`, background: color }}
      />
    </span>
  );
}

function Onboarding({
  onEnter,
}: {
  onEnter: () => void;
}) {
  const [step, setStep] = useState(0);
  const [connections, setConnections] = useState({
    github: false,
    openai: true,
    anthropic: false,
    claudeCli: true,
    codexCli: true,
  });
  const [projectName, setProjectName] = useState("Nexus Commerce");
  const [toast, setToast] = useState("");

  const connect = (key: keyof typeof connections, label: string) => {
    setConnections((current) => ({ ...current, [key]: true }));
    setToast(`${label} conectado com sucesso`);
    window.setTimeout(() => setToast(""), 2200);
  };

  const steps = [
    "Sua organização",
    "Conexões",
    "Primeiro projeto",
    "Time híbrido",
    "Ativar operação",
  ];

  return (
    <main className="onboarding-shell">
      <header className="onboarding-header">
        <button className="brand-button" onClick={() => setStep(0)}>
          <BrandMark />
          <span>
            <b>NexusOS</b>
            <small>Hybrid operations</small>
          </span>
        </button>
        <button className="text-button" onClick={onEnter}>
          Explorar workspace ativo <span>↗</span>
        </button>
      </header>

      <section className="onboarding-progress" aria-label="Progresso">
        <span>
          {String(step + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
        </span>
        <div>
          {steps.map((label, index) => (
            <button
              key={label}
              className={index <= step ? "is-active" : ""}
              onClick={() => setStep(index)}
              aria-label={`Ir para ${label}`}
            />
          ))}
        </div>
        <strong>{steps[step]}</strong>
      </section>

      {step === 0 && (
        <section className="onboarding-stage stage-welcome">
          <div className="stage-copy">
            <span className="eyebrow">Primeiro acesso · 6 minutos</span>
            <h1>
              Monte a organização
              <br />
              que trabalha <em>com você.</em>
            </h1>
            <p>
              Conecte seus projetos, forme times híbridos e dê a cada agente
              papel, contexto, memória e limites claros. O NexusOS transforma
              tudo isso na sua operação diária.
            </p>
            <div className="welcome-actions">
              <button
                className="primary-button"
                data-testid="start-onboarding"
                onClick={() => setStep(1)}
              >
                Configurar meu Nexus <span>→</span>
              </button>
              <span>Nenhum cartão ou plano pago necessário</span>
            </div>
          </div>
          <div className="org-vision-card">
            <div className="vision-label">
              <span>SEU NEXUS</span>
              <b>Um sistema vivo de responsabilidade</b>
            </div>
            <div className="vision-core">
              <span className="core-orbit orbit-one">Objetivos</span>
              <span className="core-orbit orbit-two">Decisões</span>
              <span className="core-orbit orbit-three">Memória</span>
              <span className="core-center">
                <BrandMark />
                <b>Você</b>
              </span>
            </div>
            <div className="vision-nodes">
              <span>
                <i className="node-human">RC</i>
                Humanos
              </span>
              <span>
                <i className="node-agent">AT</i>
                Agentes
              </span>
              <span>
                <i className="node-system">↗</i>
                Sistemas
              </span>
            </div>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="onboarding-stage stage-connections">
          <div className="stage-heading">
            <span className="eyebrow">01 · Conecte a operação</span>
            <h2>Seus agentes usam identidades, não chaves soltas.</h2>
            <p>
              O acesso a modelos acontece por login OAuth do provedor ou por
              uma sessão CLI autenticada em um execution pool.
            </p>
          </div>
          <div className="connection-grid">
            <article className="connection-card featured">
              <div className="provider-symbol dark">GH</div>
              <div>
                <span className="card-kicker">FORGE OBRIGATÓRIO</span>
                <h3>GitHub Free</h3>
                <p>Repositórios, Issues, Pull Requests e Check Runs.</p>
              </div>
              <button
                className={connections.github ? "connected-button" : "outline-button"}
                onClick={() => connect("github", "GitHub")}
              >
                {connections.github ? "✓ Conectado" : "Conectar via OAuth"}
              </button>
            </article>
            <article className="connection-card">
              <div className="provider-symbol green">OA</div>
              <div>
                <span className="card-kicker">PROVEDOR · OAUTH</span>
                <h3>OpenAI</h3>
                <p>Conta pessoal · consentimento por agent assignment.</p>
              </div>
              <button className="connected-button">✓ Conectado</button>
            </article>
            <article className="connection-card">
              <div className="provider-symbol violet">AN</div>
              <div>
                <span className="card-kicker">PROVEDOR · OAUTH</span>
                <h3>Anthropic</h3>
                <p>Login seguro; scopes e expiração sempre visíveis.</p>
              </div>
              <button
                className={
                  connections.anthropic ? "connected-button" : "outline-button"
                }
                onClick={() => connect("anthropic", "Anthropic")}
              >
                {connections.anthropic ? "✓ Conectado" : "Conectar via OAuth"}
              </button>
            </article>
            <article className="connection-card terminal-card">
              <div className="terminal-topbar">
                <span />
                <span />
                <span />
                <b>execution-pool / scl-01</b>
              </div>
              <div className="terminal-body">
                <span>$ nexus auth inspect</span>
                <b>claude code</b>
                <em>authenticated · healthy</em>
                <b>codex cli</b>
                <em>authenticated · healthy</em>
                <small>credentials remain inside the execution pool</small>
              </div>
            </article>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="onboarding-stage stage-project">
          <div className="stage-heading">
            <span className="eyebrow">02 · Dê forma à intenção</span>
            <h2>Comece por um projeto com um resultado claro.</h2>
            <p>
              O objetivo organiza trabalho, time, budget, memória e as decisões
              que chegarão até você.
            </p>
          </div>
          <div className="project-form-layout">
            <form className="project-form" onSubmit={(event) => event.preventDefault()}>
              <label>
                Organização
                <select defaultValue="aurora">
                  <option value="aurora">Aurora Labs</option>
                  <option value="meridian">Meridian Partners</option>
                </select>
              </label>
              <label>
                Nome do projeto
                <input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  aria-label="Nome do projeto"
                />
              </label>
              <label>
                Objetivo principal
                <textarea defaultValue="Lançar um checkout autônomo e reduzir o abandono de compra para 31% até 30 de setembro." />
              </label>
              <div className="form-row">
                <label>
                  Métrica
                  <input defaultValue="Taxa de abandono" />
                </label>
                <label>
                  Target
                  <input defaultValue="31%" />
                </label>
              </div>
            </form>
            <aside className="template-panel">
              <span className="card-kicker">TEMPLATE SELECIONADO</span>
              <h3>Software Delivery</h3>
              <ul>
                <li><span>✓</span> GitHub Issue → WorkItem</li>
                <li><span>✓</span> Agente em workspace isolado</li>
                <li><span>✓</span> PR com evidence bundle</li>
                <li><span>✓</span> Aprovação intent-bound</li>
              </ul>
              <p>Baseline OSS · nenhuma dependência de Jira ou Slack.</p>
            </aside>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="onboarding-stage stage-team">
          <div className="stage-heading">
            <span className="eyebrow">03 · Forme o time híbrido</span>
            <h2>Papéis explícitos. Autoridade sempre rastreável.</h2>
            <p>
              Humanos e agentes compartilham o time, mas cada agent assignment
              tem modelo, conexão, skills, memória e autonomia próprios.
            </p>
          </div>
          <div className="team-builder">
            <article className="team-member human-member">
              <Avatar initials="RC" color="#d7defa" />
              <span className="member-type">HUMANO · ACCOUNTABLE</span>
              <h3>Rafael Caffaro</h3>
              <p>Product Owner</p>
              <div className="member-tags">
                <span>Decide R3/R4</span>
                <span>Budget owner</span>
              </div>
            </article>
            {agents.slice(0, 3).map((agent) => (
              <article className="team-member" key={agent.id}>
                <Avatar initials={agent.initials} color={agent.color} />
                <span className="member-type">AGENTE · {agent.method}</span>
                <h3>{agent.name}</h3>
                <p>{agent.role}</p>
                <div className="connection-line">
                  <StatusDot status="Ready" />
                  <span>{agent.connection}</span>
                </div>
                <div className="member-tags">
                  <span>{agent.model}</span>
                  <span>{agent.skills} skills</span>
                </div>
              </article>
            ))}
            <button className="add-member-card">
              <span>＋</span>
              Adicionar membro
              <small>Humano ou agente</small>
            </button>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="onboarding-stage stage-launch">
          <div className="launch-visual">
            <span className="launch-ring ring-a" />
            <span className="launch-ring ring-b" />
            <div className="launch-center">
              <BrandMark />
              <b>Pronto</b>
            </div>
            <span className="launch-node node-a">GH</span>
            <span className="launch-node node-b">AT</span>
            <span className="launch-node node-c">LU</span>
            <span className="launch-node node-d">RC</span>
          </div>
          <div className="launch-copy">
            <span className="eyebrow">04 · Ative a operação</span>
            <h2>Seu Nexus está pronto para o primeiro outcome.</h2>
            <p>
              A partir de agora, projetos, agentes, decisões e evidências
              convergem em uma única experiência diária.
            </p>
            <div className="launch-checks">
              <span><b>01</b> GitHub + 4 model connections</span>
              <span><b>02</b> Projeto “{projectName}”</span>
              <span><b>03</b> Time híbrido com 4 membros</span>
              <span><b>04</b> Policy e evidence ativados</span>
            </div>
            <button
              className="primary-button launch-button"
              data-testid="launch-workspace"
              onClick={onEnter}
            >
              Entrar no meu Today <span>→</span>
            </button>
          </div>
        </section>
      )}

      {step > 0 && (
        <footer className="onboarding-footer">
          <button className="text-button" onClick={() => setStep((value) => value - 1)}>
            ← Voltar
          </button>
          {step < 4 && (
            <button
              className="primary-button compact"
              data-testid="onboarding-next"
              onClick={() => setStep((value) => value + 1)}
            >
              Continuar <span>→</span>
            </button>
          )}
        </footer>
      )}
      {toast && <div className="toast success-toast">{toast}</div>}
    </main>
  );
}

function Sidebar({
  view,
  onNavigate,
  onReset,
  workspace,
  conversationCount,
  attentionCount,
}: {
  view: View;
  onNavigate: (view: View) => void;
  onReset: () => void;
  workspace: WorkspaceState | null;
  conversationCount: number | null;
  attentionCount: number | null;
}) {
  const currentProjects =
    workspace?.projects.filter((project) => project.status !== "archived") ?? [];

  return (
    <aside className="app-sidebar">
      <button className="brand-button sidebar-brand" onClick={() => onNavigate("today")}>
        <BrandMark />
        <span>
          <b>NexusOS</b>
          <small>Operating fabric</small>
        </span>
      </button>
      <button className="org-switcher" data-testid="org-switcher">
        <span className="org-monogram">A</span>
        <span>
          <b>Aurora Labs</b>
          <small>
            1 organization · {workspace ? currentProjects.length : "…"} projects
          </small>
        </span>
        <i>⌄</i>
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
        {!workspace && (
          <span className="sidebar-project-state">Carregando workspace…</span>
        )}
        {workspace && currentProjects.length === 0 && (
          <button
            className="sidebar-project-empty"
            onClick={() => onNavigate("project")}
          >
            ＋ Criar primeiro projeto
          </button>
        )}
        {workspace &&
          currentProjects.map((project) => {
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
        <button onClick={onReset}>
          <i>◫</i>
          <span>Rever onboarding</span>
        </button>
        <div className="user-chip">
          <Avatar initials="RC" color="#d7defa" small />
          <span>
            <b>Rafael</b>
            <small>Owner</small>
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
}: {
  onCommand: () => void;
  onProvider: () => void;
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
        <Avatar initials="RC" color="#d7defa" small />
      </div>
    </header>
  );
}

function TodayView({
  onProject,
  onInbox,
  notify,
}: {
  onProject: () => void;
  onInbox: () => void;
  notify: (message: string) => void;
}) {
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  return (
    <div className="view-page today-page" data-testid="today-view">
      <div className="today-heading">
        <div>
          <span className="eyebrow live-eyebrow"><i /> Sábado · 25 de julho</span>
          <h1>Bom dia, Rafael.</h1>
          <p>Seu sistema operou por 11h 42m desde a última visita.</p>
        </div>
        <div className="heading-actions">
          <button className="outline-button" onClick={() => notify("Briefing compartilhado")}>
            Compartilhar briefing
          </button>
          <button className="primary-button compact" onClick={() => notify("Novo WorkItem criado")}>
            ＋ Criar trabalho
          </button>
        </div>
      </div>

      <section className="morning-brief">
        <div className="brief-intro">
          <span className="section-number">01</span>
          <div>
            <span className="eyebrow">MORNING BRIEF</span>
            <h2>O que precisa de você agora</h2>
            <p>3 sinais priorizados entre 126 eventos.</p>
          </div>
        </div>
        <div className="brief-items">
          <article className="brief-card decision">
            <div className="brief-type"><span>DECISÃO</span><em>8 min</em></div>
            <h3>Aprovar estratégia de rollout do checkout</h3>
            <p>Atlas recomenda 10% → 40% → 100%. O risco residual caiu para R2.</p>
            <div className="brief-context">
              <span className="mini-project lime">N</span>
              <span>Nexus Commerce · Objective #01</span>
              <span className="risk-chip">R2</span>
            </div>
            <div className="brief-actions">
              <button onClick={() => notify("Rollout aprovado com evidence")}>Aprovar</button>
              <button onClick={onInbox}>Revisar evidências →</button>
            </div>
          </article>
          <article className="brief-card risk">
            <div className="brief-type"><span>RISCO</span><em>12 min</em></div>
            <h3>Orion Data perdeu a janela de migração</h3>
            <p>Um handoff expirou. Luma preparou duas opções com impacto e custo.</p>
            <div className="brief-context">
              <span className="mini-project violet">O</span>
              <span>Orion Data · Migration wave 3</span>
              <span className="risk-chip amber">SLA</span>
            </div>
            <div className="brief-actions">
              <button onClick={onProject}>Abrir projeto</button>
              <button onClick={() => notify("Delegado para Camila")}>Delegar →</button>
            </div>
          </article>
          <article className="brief-card auth">
            <div className="brief-type"><span>AUTENTICAÇÃO</span><em>vence em 2h</em></div>
            <h3>Sessão do Claude Code precisa ser renovada</h3>
            <p>Atlas concluirá o run atual, mas novos assignments serão pausados.</p>
            <div className="brief-context">
              <span className="mini-project dark">CLI</span>
              <span>pool-scl-01 · 2 agents</span>
              <span className="risk-chip blue">CLI</span>
            </div>
            <div className="brief-actions">
              <button onClick={() => notify("Terminal de autenticação aberto")}>Renovar CLI</button>
              <button>Ver impacto →</button>
            </div>
          </article>
        </div>
      </section>

      <section className="portfolio-section">
        <div className="section-heading-row">
          <div>
            <span className="section-number">02</span>
            <span>
              <span className="eyebrow">PORTFÓLIO</span>
              <h2>3 projetos em movimento</h2>
            </span>
          </div>
          <button className="text-button" onClick={onProject}>Ver portfólio completo →</button>
        </div>
        <div className="visioning-disclosure">
          <b>VISIONING</b>
          <span>
            Estes cards ilustram métricas futuras. O portfólio persistente está
            disponível em Projetos.
          </span>
        </div>
        <div className="project-grid">
          {visionProjects.map((project) => (
            <button
              key={project.id}
              className="project-card"
              onClick={onProject}
              data-testid={`project-${project.id}`}
            >
              <div className="project-card-top">
                <span
                  className="project-icon"
                  style={{ background: project.color, color: project.accent }}
                >
                  {project.name.slice(0, 1)}
                </span>
                <span className={`health health-${project.health.toLowerCase().replaceAll(" ", "-")}`}>
                  <i /> {project.health}
                </span>
                <span className="project-more">•••</span>
              </div>
              <span className="project-company">{project.company}</span>
              <h3>{project.name}</h3>
              <p>{project.objective}</p>
              <div className="project-progress-line">
                <ProgressBar value={project.progress} color={project.color === "#e7f6c7" ? "#93c52f" : project.accent} />
                <b>{project.progress}%</b>
              </div>
              <div className="project-stats">
                <span><b>{project.activeAgents}</b> agents ativos</span>
                <span><b>{project.decisions}</b> decisões</span>
                <span className="trend-up">{project.trend}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="live-operations">
        <div className="section-heading-row">
          <div>
            <span className="section-number">03</span>
            <span>
              <span className="eyebrow">LIVE OPERATIONS</span>
              <h2>O trabalho acontecendo agora</h2>
            </span>
          </div>
          <span className="live-pill"><i /> 12 agents online</span>
        </div>
        <div className="operations-table">
          <div className="table-header">
            <span>AGENTE / PAPEL</span>
            <span>TRABALHO ATUAL</span>
            <span>CONEXÃO DE MODELO</span>
            <span>ESTADO</span>
            <span />
          </div>
          {agents.map((agent) => (
            <div className="operation-row-wrap" key={agent.id}>
              <button
                className="operation-row"
                onClick={() => setExpandedRun(expandedRun === agent.id ? null : agent.id)}
              >
                <span className="agent-cell">
                  <Avatar initials={agent.initials} color={agent.color} small />
                  <span><b>{agent.name}</b><small>{agent.role}</small></span>
                </span>
                <span>
                  <b>
                    {agent.id === "atlas" && "Implementar rollout guard"}
                    {agent.id === "luma" && "Analisar queda de conversão"}
                    {agent.id === "sentinel" && "Revisar policy de acesso"}
                    {agent.id === "forge" && "Aguardando handoff"}
                  </b>
                  <small>{agent.project}</small>
                </span>
                <span className="provider-cell">
                  <b>{agent.model}</b>
                  <small><span className={`method-badge method-${agent.method.toLowerCase()}`}>{agent.method}</span> {agent.connection}</small>
                </span>
                <span className="state-cell">
                  <StatusDot status={agent.status} />
                  {agent.status}
                </span>
                <span className="row-arrow">{expandedRun === agent.id ? "↑" : "↓"}</span>
              </button>
              {expandedRun === agent.id && (
                <div className="run-detail">
                  <span><b>Run</b> #RN-2048</span>
                  <span><b>Budget</b> $4.80 / $12.00</span>
                  <span><b>Loop</b> 6 / 18 turns</span>
                  <span><b>Memory</b> {agent.memory}</span>
                  <button onClick={() => notify(`Run de ${agent.name} aberto`)}>Abrir run room →</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProjectView({ notify }: { notify: (message: string) => void }) {
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
          <ProjectVisioningView
            project={selectedProject}
            teams={projectTeams}
            projectAgents={projectAgents}
            objectives={workspace?.objectives ?? []}
            workItems={workspace?.workItems ?? []}
            onWorkGraphChanged={() =>
              setReloadWorkspace((value) => value + 1)
            }
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

function ProjectVisioningView({
  project,
  teams,
  projectAgents,
  objectives,
  workItems,
  onWorkGraphChanged,
  notify,
}: {
  project: WorkspaceState["projects"][number];
  teams: WorkspaceState["teams"];
  projectAgents: WorkspaceState["agents"];
  objectives: WorkGraphObjective[];
  workItems: WorkGraphItem[];
  onWorkGraphChanged: () => void;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState("work");

  return (
    <div className="project-operating-preview">
      <div className="visioning-disclosure">
        <b>VISÃO OPERACIONAL PROGRESSIVA</b>
        <span>
          Projeto, composição e Work Graph são reais. Métricas, memória e
          evidence permanecem exemplos explícitos do end game.
        </span>
      </div>
      <div className="project-hero">
        <div className="project-title-area">
          <span className="project-icon large" style={{ background: "#e7f6c7", color: "#4f6818" }}>{project.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <span className="eyebrow">AURORA LABS · {project.status.toUpperCase()} · V{project.version}</span>
            <h1>{project.name}</h1>
            <p>{teams.filter((team) => team.status === "active").length} times ativos · {projectAgents.filter((agent) => agent.status === "active").length} agentes ativos</p>
          </div>
        </div>
        <div className="project-hero-actions">
          <span className={project.status === "active" ? "health health-on-track" : "health health-needs-attention"}><i /> {project.status}</span>
          <button className="outline-button" disabled title="Project Rooms entram no sprint de colaboração">Project Room · roadmap</button>
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
          <span><small>EVIDENCE</small><b>—</b><em>progressivo</em></span>
        </div>
      </section>

      <div className="project-tabs">
        {[
          ["work", "Work · real"],
          ["team", "Time híbrido · real"],
          ["memory", "Memória · visioning"],
          ["evidence", "Evidence · visioning"],
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

      {tab === "memory" && (
        <section className="memory-view">
          <div className="memory-header">
            <div><span className="eyebrow">MEMORY GRAPH</span><h2>O que o time sabe — e por quê</h2></div>
            <button className="primary-button compact" disabled>＋ Propor memória · roadmap</button>
          </div>
          <div className="memory-grid">
            {[
              ["Procedural", "Checkout rollout playbook", "12 sources · reviewed", "Team"],
              ["Semantic", "Abandono cresce após 3DS", "8 sources · 92% confidence", "Project"],
              ["Episodic", "Incident #INC-048", "Expires in 21 days", "Atlas"],
              ["Preference", "Rafael prefere 3 alternativas", "Explicit · editable", "User"],
            ].map((item) => (
              <article key={item[1]}>
                <span>{item[0]}</span>
                <h3>{item[1]}</h3>
                <p>{item[2]}</p>
                <footer><b>{item[3]}</b><button disabled>Ver fontes →</button></footer>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "evidence" && (
        <section className="evidence-view">
          <div className="evidence-score"><strong>2 / 7</strong><span>camadas implementadas</span></div>
          <div className="evidence-chain">
            {["Objective", "WorkItem", "Run", "ActionIntent", "Decision", "Artifact", "Outcome"].map((item, index) => (
              <span key={item}><i>{String(index + 1).padStart(2, "0")}</i>{item}</span>
            ))}
          </div>
          <button className="outline-button" disabled>Exportar bundle · roadmap</button>
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

function OutputsView({ notify }: { notify: (message: string) => void }) {
  const outputs = [
    { id: "out-482", type: "Code", title: "PR #482 · Rollout guard", project: "Nexus Commerce", owner: "Atlas", version: "a18f9d2", status: "Review", time: "8 min", meta: "GitHub Pull Request · 6/6 checks", tone: "lime" },
    { id: "out-229", type: "Decision", title: "Rollout strategy memo", project: "Nexus Commerce", owner: "Atlas + Rafael", version: "DEC-204", status: "Signed", time: "12 min", meta: "Markdown · 4 evidências", tone: "violet" },
    { id: "out-881", type: "Report", title: "Migration window analysis", project: "Orion Data", owner: "Luma", version: "v3.2", status: "Input", time: "24 min", meta: "Interactive report · 2 scenarios", tone: "orange" },
    { id: "out-144", type: "Data", title: "Checkout conversion forecast", project: "Nexus Commerce", owner: "Luma", version: "v12", status: "Current", time: "31 min", meta: "Parquet + notebook · 18.4 MB", tone: "cyan" },
    { id: "out-771", type: "Release", title: "checkout-service production", project: "Nexus Commerce", owner: "Forge", version: "v2.18.4", status: "Deployed", time: "42 min", meta: "Production · attested", tone: "dark" },
  ];
  const [filter, setFilter] = useState("All");
  const [selectedId, setSelectedId] = useState("out-482");
  const filteredOutputs = filter === "All" ? outputs : outputs.filter((output) => output.type === filter);
  const selected = outputs.find((output) => output.id === selectedId) ?? outputs[0];

  return (
    <div className="view-page outputs-page" data-testid="outputs-view">
      <div className="page-heading">
        <div><span className="eyebrow">ARTIFACT REGISTRY</span><h1>Outputs dos times</h1><p>Tudo que um humano ou agente entrega, com versão, origem e evidências.</p></div>
        <button className="primary-button compact" onClick={() => notify("Fluxo de publicação de artifact aberto")}>＋ Publicar output</button>
      </div>
      <section className="artifact-summary">
        <div><small>OUTPUTS · 30 DIAS</small><b>284</b><em>92% linked to outcomes</em></div>
        <div><small>AGUARDANDO HUMANO</small><b>7</b><em>3 decisions · 4 reviews</em></div>
        <div><small>PROVENANCE</small><b>100%</b><em>creator + run + commit</em></div>
        <div><small>STALE</small><b>2</b><em>owner notified</em></div>
      </section>
      <div className="artifact-workspace">
        <section className="artifact-directory">
          <div className="artifact-toolbar">
            <div>
              {["All", "Code", "Decision", "Report", "Data", "Release"].map((item) => (
                <button key={item} className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{item}</button>
              ))}
            </div>
            <button onClick={() => notify("Filtros avançados abertos")}>Filter ⌄</button>
          </div>
          <div className="artifact-table-head"><span>OUTPUT</span><span>PROJETO / OWNER</span><span>VERSÃO</span><span>STATUS</span><span>UPDATED</span></div>
          {filteredOutputs.map((output) => (
            <button className={`artifact-row ${selected.id === output.id ? "is-selected" : ""}`} key={output.id} onClick={() => setSelectedId(output.id)}>
              <span className={`artifact-symbol tone-${output.tone}`}>{output.type.slice(0, 2).toUpperCase()}</span>
              <span><b>{output.title}</b><small>{output.meta}</small></span>
              <span><b>{output.project}</b><small>by {output.owner}</small></span>
              <code>{output.version}</code>
              <span className="artifact-status">{output.status}</span>
              <time>{output.time}</time>
            </button>
          ))}
        </section>
        <aside className="artifact-detail">
          <span className="eyebrow">SELECTED OUTPUT</span>
          <div className={`artifact-symbol detail-symbol tone-${selected.tone}`}>{selected.type.slice(0, 2).toUpperCase()}</div>
          <h2>{selected.title}</h2>
          <p>{selected.meta}</p>
          <div className="artifact-actions"><button className="primary-button compact" onClick={() => notify(`${selected.title} aberto`)}>Abrir output ↗</button><button className="outline-button" onClick={() => notify("Link copiado")}>Copiar link</button></div>
          <dl>
            <div><dt>Created by</dt><dd>{selected.owner}</dd></div>
            <div><dt>Project</dt><dd>{selected.project}</dd></div>
            <div><dt>Version</dt><dd>{selected.version}</dd></div>
            <div><dt>Integrity</dt><dd>✓ SHA-256 verified</dd></div>
          </dl>
          <div className="lineage-card">
            <span className="eyebrow">LINEAGE</span>
            <div><span>Objective</span><i>→</i><span>WI-298</span><i>→</i><span>RUN-2048</span><i>→</i><b>{selected.id}</b></div>
          </div>
          <div className="linked-context"><b>Linked context</b><a>Decision DEC-204 ↗</a><a>Evidence bundle EVD-918 ↗</a><a>Conversation with Atlas ↗</a></div>
        </aside>
      </div>
    </div>
  );
}

function ReleasesView({ notify }: { notify: (message: string) => void }) {
  const pullRequests = [
    ["#482", "feat: rollout guard", "Atlas", "Ready", "6 / 6", "Production", "a18f9d2"],
    ["#479", "fix: retry payment intent", "Forge", "Review", "5 / 6", "Preview", "3c871e0"],
    ["#476", "chore: checkout telemetry", "Camila + Atlas", "Changes", "4 / 6", "—", "f41bc11"],
    ["#471", "feat: recovery copy", "Camila", "Draft", "2 / 6", "—", "7182acf"],
  ];
  return (
    <div className="view-page releases-page" data-testid="releases-view">
      <div className="page-heading">
        <div><span className="eyebrow">DELIVERY CONTROL PLANE</span><h1>PRs & releases</h1><p>Do pull request à última versão em produção, sem perder contexto ou proveniência.</p></div>
        <button className="outline-button" onClick={() => notify("Sincronização com GitHub concluída")}>↻ Sync GitHub</button>
      </div>
      <section className="production-card">
        <div className="production-status"><span><i /> PRODUCTION · HEALTHY</span><small>checkout.nexus.example</small></div>
        <div className="production-version"><span className="eyebrow">LAST VERSION DEPLOYED</span><h2>v2.18.4</h2><code>a18f9d2</code><p>Deployed há 42 min por Forge · origin PR #468</p></div>
        <div className="production-metrics">
          <span><small>ERROR RATE</small><b>0.08%</b><em>within SLO</em></span>
          <span><small>P95</small><b>182ms</b><em>↓ 14ms</em></span>
          <span><small>TRAFFIC</small><b>100%</b><em>stable</em></span>
        </div>
        <div className="production-actions"><button className="primary-button compact" onClick={() => notify("Produção aberta")}>Abrir produção ↗</button><button className="outline-button" onClick={() => notify("Runbook de rollback aberto")}>Rollback plan</button></div>
      </section>
      <section className="release-flow">
        <div className="release-stage is-done"><span>01</span><div><small>PR MERGED</small><b>#468</b><em>Camila + Atlas</em></div></div>
        <i>→</i>
        <div className="release-stage is-done"><span>02</span><div><small>CI / EVALS</small><b>6 / 6</b><em>248 tests</em></div></div>
        <i>→</i>
        <div className="release-stage is-done"><span>03</span><div><small>HITL GATE</small><b>DEC-198</b><em>signed by Rafael</em></div></div>
        <i>→</i>
        <div className="release-stage is-done"><span>04</span><div><small>DEPLOYED</small><b>v2.18.4</b><em>attested</em></div></div>
      </section>
      <section className="pr-section">
        <div className="section-heading"><div><span className="section-number">01</span><span><span className="eyebrow">PULL REQUESTS</span><h2>Em movimento</h2></span></div><button onClick={() => notify("GitHub Pull Requests aberto")}>Ver no GitHub ↗</button></div>
        <div className="pr-table">
          <div className="pr-table-head"><span>PR / CHANGE</span><span>OWNER</span><span>STATE</span><span>CHECKS</span><span>ENV</span><span>COMMIT</span></div>
          {pullRequests.map((pr) => (
            <button key={pr[0]} onClick={() => notify(`${pr[0]} aberto com contexto completo`)}>
              <span><b>{pr[0]}</b><small>{pr[1]}</small></span>
              <span>{pr[2]}</span>
              <span className={`pr-state state-${pr[3].toLowerCase()}`}>{pr[3]}</span>
              <span>{pr[4]}</span>
              <span>{pr[5]}</span>
              <code>{pr[6]}</code>
            </button>
          ))}
        </div>
      </section>
      <section className="release-principle">
        <span>OSS / FREE BASELINE</span>
        <p>GitHub Deployments registra SHA, ambiente, status, URL, logs e PR de origem. Gates HITL privados ficam no NexusOS quando recursos pagos de environment protection não estiverem disponíveis.</p>
        <b>GitHub events → Nexus policy gate → deployment status → attestation</b>
      </section>
    </div>
  );
}

function LedgerView({
  notify,
  focusIntentId,
  onFocusConsumed,
}: {
  notify: (message: string) => void;
  focusIntentId: string;
  onFocusConsumed: () => void;
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
                })
              : undefined,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "operation failed");
      }
      if (action === "propose") onFocusConsumed();
      window.dispatchEvent(new Event("nexus-attention-changed"));
      notify(
        action === "propose"
          ? "ActionIntent real proposto e encadeado"
          : action === "approve"
            ? "Aprovação humana vinculada ao payload"
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
      setLiveError(
        error instanceof Error ? error.message : "Operação indisponível",
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
              reais. O efeito final continua explicitamente simulado.
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
            <code>expiry real · precondition/fencing simulados</code>
          </div>
        </div>
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
              latestIntent?.status !== "proposed"
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
            Executar simulação
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

function AgentsView({ onProvider, notify }: { onProvider: () => void; notify: (message: string) => void }) {
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
        <div className="heading-actions"><button className="outline-button" data-testid="open-team-editor" disabled={!workspace || workspaceSaving} onClick={openNewTeam}>＋ Novo time</button><button className="primary-button compact" data-testid="open-agent-editor" disabled={!workspace || workspaceSaving || selectedTeam?.status === "archived"} onClick={openNewAgent}>＋ Novo agente</button></div>
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

function AutomationsView({ notify }: { notify: (message: string) => void }) {
  const [paused, setPaused] = useState<string[]>([]);
  const automations = [
    ["auto-01", "Morning operations brief", "Every weekday · 07:30 BRT", "Luma", "Today + Inbox", "$1.84/day", "07:30 tomorrow"],
    ["auto-02", "Checkout regression watch", "Every 30 minutes", "Sentinel", "Incident if > 2σ", "$4.20/day", "in 18 min"],
    ["auto-03", "GitHub issue triage", "On issue.opened", "Atlas", "Assign + clarify", "$0.72/day", "event-driven"],
    ["auto-04", "Weekly memory promotion", "Friday · 17:00 BRT", "Luma", "Review required", "$2.30/week", "in 6 days"],
  ];
  return (
    <div className="view-page automations-page" data-testid="automations-view">
      <div className="page-heading">
        <div><span className="eyebrow">DURABLE OPERATIONS</span><h1>Automações</h1><p>Trabalho recorrente com owner, budget, policy e condição de parada.</p></div>
        <button className="primary-button compact" onClick={() => notify("Automation Studio aberto")}>＋ Nova automação</button>
      </div>
      <div className="automation-summary">
        <span><small>ATIVAS</small><b>18</b><em>↑ 3 este mês</em></span>
        <span><small>ON-TIME</small><b>99.4%</b><em>2 misfires reconciled</em></span>
        <span><small>CUSTO PREVISTO</small><b>$286</b><em>Julho · 64% budget</em></span>
        <span><small>ÓRFÃS</small><b>0</b><em>Owner revalidated</em></span>
      </div>
      <section className="automation-list">
        <div className="automation-list-head">
          <span>AUTOMAÇÃO</span><span>TRIGGER</span><span>AGENTE / OUTPUT</span><span>CUSTO</span><span>PRÓXIMO</span><span />
        </div>
        {automations.map((item) => {
          const isPaused = paused.includes(item[0]);
          return (
            <div className={`automation-row ${isPaused ? "is-paused" : ""}`} key={item[0]}>
              <span><StatusDot status={isPaused ? "Waiting" : "Running"} /><span><b>{item[1]}</b><small>Nexus Commerce · {item[0]}</small></span></span>
              <span><b>{item[2]}</b><small>timezone-aware · overlap forbid</small></span>
              <span><b>{item[3]}</b><small>{item[4]}</small></span>
              <span><b>{item[5]}</b><small>within forecast</small></span>
              <span><b>{isPaused ? "Paused" : item[6]}</b><small>{isPaused ? "No new firings" : "policy will revalidate"}</small></span>
              <button onClick={() => {
                setPaused((current) => isPaused ? current.filter((id) => id !== item[0]) : [...current, item[0]]);
                notify(isPaused ? "Automação retomada" : "Automação pausada");
              }}>{isPaused ? "Retomar" : "Pausar"}</button>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function ProvidersView({ notify }: { notify: (message: string) => void }) {
  const [mode, setMode] = useState<"all" | "oauth" | "cli">("all");
  const filtered = providers.filter((provider) => mode === "all" || provider.method.toLowerCase() === mode);
  return (
    <div className="view-page providers-page" data-testid="providers-view">
      <div className="page-heading">
        <div><span className="eyebrow">MODEL ACCESS FABRIC</span><h1>Provedores & sessões</h1><p>OAuth ou CLI autenticada. Nunca API keys espalhadas por agents.</p></div>
        <button className="primary-button compact" onClick={() => notify("Nova conexão iniciada")}>＋ Nova conexão</button>
      </div>
      <section className="provider-principle">
        <div className="principle-copy">
          <span className="section-number">01</span>
          <div><span className="eyebrow">COMO FUNCIONA</span><h2>O agent recebe uma referência. A credencial fica no broker ou no execution pool.</h2></div>
        </div>
        <div className="auth-flow">
          <span><i>1</i>Agent assignment</span><b>→</b>
          <span><i>2</i>Model policy</span><b>→</b>
          <span><i>3</i>OAuth broker / CLI pool</span><b>→</b>
          <span><i>4</i>Model invocation</span>
        </div>
      </section>
      <div className="provider-filters">
        <button className={mode === "all" ? "is-active" : ""} onClick={() => setMode("all")}>Todas</button>
        <button className={mode === "oauth" ? "is-active" : ""} onClick={() => setMode("oauth")}>OAuth</button>
        <button className={mode === "cli" ? "is-active" : ""} onClick={() => setMode("cli")}>CLI sessions</button>
      </div>
      <div className="provider-directory">
        {filtered.map((provider) => (
          <article className="provider-card" key={provider.name}>
            <div className={`provider-logo ${provider.tone}`}>{provider.name.slice(0, 2).toUpperCase()}</div>
            <span className="provider-status"><StatusDot status="Ready" />{provider.status}</span>
            <span className="method-label">{provider.method}</span>
            <h3>{provider.name}</h3>
            <p>{provider.detail}</p>
            <dl>
              <div><dt>Scope</dt><dd>{provider.method === "OAuth" ? "Model invocation" : "Execution pool"}</dd></div>
              <div><dt>Agents</dt><dd>{provider.method === "OAuth" ? "2–4 assignments" : "2 active"}</dd></div>
              <div><dt>Reauth</dt><dd>{provider.method === "OAuth" ? "13–21 days" : "2 hours"}</dd></div>
            </dl>
            <button onClick={() => notify(`${provider.name}: detalhes de conexão abertos`)}>Gerenciar conexão →</button>
          </article>
        ))}
      </div>
      <section className="connection-policy">
        <div><span className="eyebrow">POLICY DEFAULT</span><h2>Quando uma conexão expira</h2></div>
        <div className="policy-steps">
          <span><b>01</b>Run atual conclui dentro da lease</span>
          <span><b>02</b>Novos assignments pausam</span>
          <span><b>03</b>Owner recebe AttentionItem</span>
          <span><b>04</b>Fallback só ocorre se semanticamente compatível</span>
        </div>
      </section>
    </div>
  );
}

function CommandPalette({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (view: View) => void;
}) {
  const commands = [
    ["Abrir briefing do dia", "today", "⌂"],
    ["Conversar com Atlas sobre PR #482", "messages", "◌"],
    ["Ver quem está no Team Room", "rooms", "⌗"],
    ["Criar WorkItem em Nexus Commerce", "project", "＋"],
    ["Revisar decisões pendentes", "inbox", "◇"],
    ["Ver outputs do time Checkout", "outputs", "▤"],
    ["Ver última versão em produção", "releases", "↗"],
    ["Ver agents com sessão CLI", "providers", "⌁"],
    ["Ver reason why de DEC-204", "ledger", "≋"],
    ["Pausar automações do Orion Data", "automations", "↻"],
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
          <span>CONTEXT</span><b>Aurora Labs / Todos os projetos</b>
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

export default function Home() {
  const [view, setView] = useState<View>("welcome");
  const [commandOpen, setCommandOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [workspaceSummary, setWorkspaceSummary] =
    useState<WorkspaceState | null>(null);
  const [conversationCount, setConversationCount] = useState<number | null>(
    null,
  );
  const [attentionCount, setAttentionCount] = useState<number | null>(null);
  const realtimeStatusRef = useRef("probing");
  const [focusedIntentId, setFocusedIntentId] = useState("");
  const [messageFocusId, setMessageFocusId] = useState("");
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>(
    {},
  );
  const clearFocusedIntent = useCallback(() => setFocusedIntentId(""), []);
  const navigate = useCallback((nextView: View) => {
    if (nextView !== "ledger") setFocusedIntentId("");
    if (nextView === "messages") setMessageFocusId("");
    setView(nextView);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [view]);

  useEffect(() => {
    let active = true;
    const loadWorkspaceSummary = () => {
      fetch("/api/workspace", { cache: "no-store" })
        .then((response) => {
          if (!response.ok) {
            throw new Error("workspace unavailable");
          }
          return response.json() as Promise<WorkspaceState>;
        })
        .then((workspace) => {
          if (active) {
            setWorkspaceSummary(workspace);
          }
        })
        .catch(() => {
          if (active) {
            setWorkspaceSummary(null);
          }
        });
    };
    loadWorkspaceSummary();
    window.addEventListener("nexus-workspace-changed", loadWorkspaceSummary);
    return () => {
      active = false;
      window.removeEventListener(
        "nexus-workspace-changed",
        loadWorkspaceSummary,
      );
    };
  }, []);

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
  }, [view]);

  useEffect(() => {
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
  }, []);

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
    if (view === "today") return <TodayView onProject={() => setView("project")} onInbox={() => setView("inbox")} notify={notify} />;
    if (view === "messages") return <MessagesView onProject={() => setView("project")} onOutput={() => setView("outputs")} notify={notify} workspace={workspaceSummary} drafts={messageDrafts} onDraftChange={updateMessageDraft} initialConversationId={messageFocusId} onInitialConversationConsumed={() => setMessageFocusId("")} />;
    if (view === "rooms") return <RoomsView onMessage={(conversationId) => { setMessageFocusId(conversationId); setView("messages"); }} notify={notify} />;
    if (view === "project") return <ProjectView notify={notify} />;
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
    if (view === "outputs") return <OutputsView notify={notify} />;
    if (view === "releases") return <ReleasesView notify={notify} />;
    if (view === "agents") return <AgentsView onProvider={() => setView("providers")} notify={notify} />;
    if (view === "automations") return <AutomationsView notify={notify} />;
    if (view === "providers") return <ProvidersView notify={notify} />;
    if (view === "ledger")
      return (
        <LedgerView
          notify={notify}
          focusIntentId={focusedIntentId}
          onFocusConsumed={clearFocusedIntent}
        />
      );
    return null;
  })();

  if (view === "welcome") {
    return <Onboarding onEnter={() => setView("today")} />;
  }

  return (
    <RealtimeProvider>
      <PresenceProvider>
        <div className="app-shell">
      <Sidebar
        view={view}
        onNavigate={navigate}
        onReset={() => navigate("welcome")}
        workspace={workspaceSummary}
        conversationCount={conversationCount}
        attentionCount={attentionCount}
      />
      <div className="app-main">
        <AppHeader
          onCommand={() => setCommandOpen(true)}
          onProvider={() => navigate("providers")}
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
        />
      )}
        {toast && <div className="toast">{toast}<span>✓</span></div>}
        </div>
      </PresenceProvider>
    </RealtimeProvider>
  );
}
