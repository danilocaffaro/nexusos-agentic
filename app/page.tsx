"use client";

import { useCallback, useEffect, useState } from "react";

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

type Project = {
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
    name: string;
    status: "active" | "paused" | "archived";
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
};

const projects: Project[] = [
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
}: {
  view: View;
  onNavigate: (view: View) => void;
  onReset: () => void;
}) {
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
          <small>2 organizations · 3 projects</small>
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
                {item.id === "messages" && <b className="nav-count message-count">4</b>}
                {item.id === "inbox" && <b className="nav-count">6</b>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-projects">
        <span className="nav-label">PROJETOS AO VIVO</span>
        {projects.map((project) => (
          <button
            key={project.id}
            onClick={() => onNavigate("project")}
            className="sidebar-project"
          >
            <i style={{ background: project.color, color: project.accent }}>
              {project.name.slice(0, 1)}
            </i>
            <span>
              <b>{project.name}</b>
              <small>{project.activeAgents} agents ativos</small>
            </span>
            {project.decisions > 0 && <em>{project.decisions}</em>}
          </button>
        ))}
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
  return (
    <header className="app-header">
      <button className="global-search" onClick={onCommand}>
        <span>⌕</span>
        Pergunte ou acione qualquer projeto…
        <kbd>⌘ K</kbd>
      </button>
      <div className="header-actions">
        <button className="system-health" onClick={onProvider}>
          <span />
          Systems healthy
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
        <div className="project-grid">
          {projects.map((project) => (
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
  const [tab, setTab] = useState("work");
  const workColumns = [
    {
      title: "READY",
      count: 3,
      items: [
        ["WI-312", "Instrumentar fallback de pagamento", "Luma", "R1"],
        ["WI-318", "Redigir playbook de incidentes", "Atlas", "R1"],
      ],
    },
    {
      title: "IN PROGRESS",
      count: 4,
      items: [
        ["WI-298", "Implementar rollout guard", "Atlas", "R2"],
        ["WI-304", "Analisar conversão mobile", "Luma", "R1"],
      ],
    },
    {
      title: "WAITING",
      count: 2,
      items: [
        ["WI-301", "Validar copy de recuperação", "Rafael", "INPUT"],
        ["WI-307", "Aprovar target de produção", "Rafael", "R3"],
      ],
    },
    {
      title: "DONE · 7 DAYS",
      count: 11,
      items: [
        ["WI-281", "Criar adapter do antifraude", "Forge", "✓"],
        ["WI-286", "Evals de abandono de carrinho", "Luma", "✓"],
      ],
    },
  ];

  return (
    <div className="view-page project-page" data-testid="project-view">
      <div className="project-hero">
        <div className="project-title-area">
          <span className="project-icon large" style={{ background: "#e7f6c7", color: "#4f6818" }}>N</span>
          <div>
            <span className="eyebrow">AURORA LABS · SOFTWARE DELIVERY</span>
            <h1>Nexus Commerce</h1>
            <p>Liderado pelo time Checkout Evolution · 4 humanos + 4 agentes</p>
          </div>
        </div>
        <div className="project-hero-actions">
          <span className="health health-on-track"><i /> On track</span>
          <button className="outline-button" onClick={() => notify("Project Room aberto")}>Abrir Project Room</button>
          <button className="primary-button compact" onClick={() => notify("Novo WorkItem criado")}>＋ WorkItem</button>
        </div>
      </div>

      <section className="objective-strip">
        <div>
          <span className="eyebrow">OBJETIVO ATIVO · Q3</span>
          <h2>Lançar checkout autônomo e reduzir abandono para 31%</h2>
          <p>Owner Rafael · Atualizado há 18 min por Luma · Fonte: product analytics</p>
        </div>
        <div className="objective-progress">
          <strong>72%</strong>
          <span><ProgressBar value={72} /><small>18 dias restantes</small></span>
        </div>
        <div className="objective-metrics">
          <span><small>ABANDONO</small><b>34,8%</b><em>↓ 2,1 pp</em></span>
          <span><small>PRs ACEITOS</small><b>18 / 22</b><em>82%</em></span>
          <span><small>CUSTO / OUTCOME</small><b>$18.40</b><em>↓ 14%</em></span>
        </div>
      </section>

      <div className="project-tabs">
        {[
          ["work", "Work"],
          ["team", "Time híbrido"],
          ["memory", "Memória"],
          ["evidence", "Evidence"],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "work" && (
        <section className="work-board">
          {workColumns.map((column) => (
            <div className="work-column" key={column.title}>
              <div className="column-heading">
                <span>{column.title}</span>
                <b>{column.count}</b>
              </div>
              {column.items.map((item) => (
                <article className="work-card" key={item[0]}>
                  <div>
                    <span>{item[0]}</span>
                    <em className={item[3] === "R3" ? "risk-high" : ""}>{item[3]}</em>
                  </div>
                  <h3>{item[1]}</h3>
                  <footer>
                    <span className="work-owner">{item[2].slice(0, 2).toUpperCase()}</span>
                    <span>GitHub #482</span>
                    <i>•••</i>
                  </footer>
                </article>
              ))}
              <button className="add-work">＋ Adicionar trabalho</button>
            </div>
          ))}
        </section>
      )}

      {tab === "team" && (
        <section className="team-tab-grid">
          {agents.slice(0, 3).map((agent) => (
            <article className="agent-profile-card" key={agent.id}>
              <div className="agent-profile-top">
                <Avatar initials={agent.initials} color={agent.color} />
                <StatusDot status={agent.status} />
              </div>
              <span className="member-type">AGENTE · {agent.method}</span>
              <h3>{agent.name}</h3>
              <p>{agent.role}</p>
              <dl>
                <div><dt>Modelo</dt><dd>{agent.model}</dd></div>
                <div><dt>Conexão</dt><dd>{agent.connection}</dd></div>
                <div><dt>Skills</dt><dd>{agent.skills} ativas</dd></div>
                <div><dt>Memória</dt><dd>{agent.memory}</dd></div>
              </dl>
            </article>
          ))}
          <article className="agent-profile-card human-profile">
            <div className="agent-profile-top">
              <Avatar initials="RC" color="#d7defa" />
              <StatusDot status="Ready" />
            </div>
            <span className="member-type">HUMANO · ACCOUNTABLE</span>
            <h3>Rafael Caffaro</h3>
            <p>Product Owner</p>
            <dl>
              <div><dt>Authority</dt><dd>R0–R4</dd></div>
              <div><dt>Decisions</dt><dd>12 esta semana</dd></div>
              <div><dt>SLA</dt><dd>24 min median</dd></div>
            </dl>
          </article>
        </section>
      )}

      {tab === "memory" && (
        <section className="memory-view">
          <div className="memory-header">
            <div><span className="eyebrow">MEMORY GRAPH</span><h2>O que o time sabe — e por quê</h2></div>
            <button className="primary-button compact" onClick={() => notify("Memory proposal criada")}>＋ Propor memória</button>
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
                <footer><b>{item[3]}</b><button>Ver fontes →</button></footer>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "evidence" && (
        <section className="evidence-view">
          <div className="evidence-score"><strong>99.8%</strong><span>Evidence completeness</span></div>
          <div className="evidence-chain">
            {["Objective", "WorkItem", "Run", "ActionIntent", "Decision", "Artifact", "Outcome"].map((item, index) => (
              <span key={item}><i>{String(index + 1).padStart(2, "0")}</i>{item}</span>
            ))}
          </div>
          <button className="outline-button" onClick={() => notify("Evidence bundle exportado")}>Exportar bundle verificável</button>
        </section>
      )}
    </div>
  );
}

function InboxView({ notify }: { notify: (message: string) => void }) {
  const [selected, setSelected] = useState("apr-204");
  const [resolved, setResolved] = useState<string[]>([]);
  const inboxItems = [
    ["apr-204", "APPROVAL", "Rollout guard → produção", "Atlas · Nexus Commerce", "R2", "8 min"],
    ["inp-118", "INPUT", "Escolher janela de migração", "Luma · Orion Data", "SLA", "12 min"],
    ["auth-42", "AUTH", "Renovar Claude Code CLI", "pool-scl-01 · 2 agents", "CLI", "2 h"],
    ["inc-09", "INCIDENT", "Handoff expirado", "Orion Data · wave 3", "R2", "34 min"],
    ["ack-31", "ACK", "Novo policy bundle publicado", "Security · Organization", "POL", "1 h"],
  ];
  const active = inboxItems.find((item) => item[0] === selected) ?? inboxItems[0];
  const isActiveResolved = resolved.includes(active[0]);

  return (
    <div className="view-page inbox-page" data-testid="inbox-view">
      <div className="page-heading">
        <div><span className="eyebrow">ATTENTION SYSTEM</span><h1>Inbox</h1><p>6 itens exigem decisão ou conhecimento seu.</p></div>
        <div className="inbox-stats"><span><b>18 min</b>mediana</span><span><b>94%</b>precision</span></div>
      </div>
      <div className="inbox-layout">
        <aside className="inbox-list">
          <div className="inbox-filters">
            <button className="is-active">Minha fila <b>6</b></button>
            <button>Delegados <b>2</b></button>
            <button>FYI <b>18</b></button>
          </div>
          {inboxItems.map((item) => (
            <button
              key={item[0]}
              className={`${selected === item[0] ? "is-selected" : ""} ${resolved.includes(item[0]) ? "is-resolved" : ""}`}
              onClick={() => setSelected(item[0])}
            >
              <span className={`inbox-type type-${item[1].toLowerCase()}`}>{item[1]}</span>
              <h3>{item[2]}</h3>
              <p>{item[3]}</p>
              <footer><span>{item[4]}</span><em>{resolved.includes(item[0]) ? "Resolvido" : item[5]}</em></footer>
            </button>
          ))}
        </aside>
        <section className="decision-detail">
          <div className="decision-breadcrumb">NEXUS COMMERCE / WI-298 / RUN-2048</div>
          <div className="decision-title">
            <span className="decision-icon">{isActiveResolved ? "✓" : "!"}</span>
            <div><span className="eyebrow">{active[1]} {isActiveResolved ? "RESOLVED" : "REQUIRED"}</span><h2>{active[2]}</h2><p>Proposto por Atlas · Engineering Lead · há 8 min</p></div>
          </div>
          <div className="intent-card">
            <span>INTENÇÃO EXATA</span>
            <code>deploy checkout-service@a18f9d → production / 10% traffic</code>
            <dl>
              <div><dt>Risk</dt><dd>R2 · reversible</dd></div>
              <div><dt>Budget</dt><dd>$12.40 max</dd></div>
              <div><dt>Window</dt><dd>60 minutes</dd></div>
              <div><dt>Rollback</dt><dd>Automatic &lt; 2 min</dd></div>
            </dl>
          </div>
          <div className="evidence-preview">
            <div className="detail-section-heading"><span>EVIDÊNCIAS</span><b>6 / 6 checks</b></div>
            {[
              ["Unit + integration tests", "248 passed"],
              ["Security policy", "No violations"],
              ["Canary forecast", "98.6% confidence"],
              ["Cost estimate", "$8.20 expected"],
            ].map((item) => (
              <div key={item[0]}><span>✓</span><b>{item[0]}</b><em>{item[1]}</em></div>
            ))}
          </div>
          {isActiveResolved ? (
            <div className="decision-resolved" data-testid="decision-resolved">
              <span>✓</span>
              <div>
                <b>Decisão aprovada. Execução liberada.</b>
                <small>Vinculada ao intent hash e adicionada à trilha de evidências.</small>
              </div>
            </div>
          ) : (
            <div className="decision-actions">
              <button
                className="primary-button"
                data-testid="approve-decision"
                onClick={() => {
                  setResolved((current) => [...current, active[0]]);
                  notify("Decisão aprovada e vinculada ao intent hash");
                }}
              >
                Aprovar rollout
              </button>
              <button className="outline-button" onClick={() => notify("Escopo editável aberto")}>Editar escopo</button>
              <button className="text-button danger-text" onClick={() => notify("Decisão rejeitada")}>Rejeitar</button>
            </div>
          )}
          <p className="intent-hash">Intent hash · sha256:81dc…a921 · target state verified 14s ago</p>
        </section>
      </div>
    </div>
  );
}

function MessagesView({
  onProject,
  onOutput,
  notify,
}: {
  onProject: () => void;
  onOutput: () => void;
  notify: (message: string) => void;
}) {
  const conversations = [
    { id: "atlas", kind: "direct", initials: "AT", name: "Atlas", meta: "Agent · Engineering Lead", preview: "PR #482 está pronto para revisão.", time: "agora", unread: 2, color: "#ddf5a1", mode: "CLI · Claude Opus" },
    { id: "camila", kind: "direct", initials: "CM", name: "Camila Mendes", meta: "Humana · Product Design", preview: "Comentei o novo fluxo no artifact.", time: "8m", unread: 1, color: "#ffd9c2", mode: "Humana · Aurora Labs" },
    { id: "luma", kind: "direct", initials: "LU", name: "Luma", meta: "Agent · Product Analyst", preview: "Atualizei o forecast de conversão.", time: "12m", unread: 1, color: "#d8d1ff", mode: "OAuth · GPT-5" },
    { id: "room", kind: "rooms", initials: "#", name: "checkout-evolution", meta: "Room · 8 membros", preview: "Sentinel anexou o policy report.", time: "19m", unread: 0, color: "#cfeaec", mode: "4 humanos · 4 agents" },
    { id: "handoff", kind: "handoffs", initials: "↗", name: "Atlas → Forge", meta: "Handoff · WI-298", preview: "Implementação pronta para deploy.", time: "26m", unread: 0, color: "#e7f6c7", mode: "Run context · evidence included" },
  ];
  const [conversationMode, setConversationMode] = useState<"direct" | "rooms" | "handoffs">("direct");
  const [selectedId, setSelectedId] = useState("atlas");
  const [draft, setDraft] = useState("");
  const [sentMessages, setSentMessages] = useState<string[]>([]);
  const selectedConversation = conversations.find((item) => item.id === selectedId) ?? conversations[0];
  const visibleConversations = conversations.filter((item) => item.kind === conversationMode);

  const sendMessage = () => {
    const value = draft.trim();
    if (!value) return;
    setSentMessages((current) => [...current, value]);
    setDraft("");
    notify("Mensagem enviada com o contexto do projeto");
  };

  return (
    <div className="view-page messages-page" data-testid="messages-view">
      <div className="page-heading">
        <div><span className="eyebrow">COLLABORATION FABRIC</span><h1>Mensagens</h1><p>Conversas com humanos e agentes, sempre ancoradas ao trabalho real.</p></div>
        <button className="primary-button compact" onClick={() => notify("Nova conversa aberta")}>＋ Nova conversa</button>
      </div>
      <div className="messenger-shell">
        <aside className="conversation-list">
          <div className="conversation-tabs">
            <button className={conversationMode === "direct" ? "is-active" : ""} onClick={() => { setConversationMode("direct"); setSelectedId("atlas"); }}>Direct <b>4</b></button>
            <button className={conversationMode === "rooms" ? "is-active" : ""} onClick={() => { setConversationMode("rooms"); setSelectedId("room"); }}>Rooms</button>
            <button className={conversationMode === "handoffs" ? "is-active" : ""} onClick={() => { setConversationMode("handoffs"); setSelectedId("handoff"); }}>Handoffs</button>
          </div>
          <label className="conversation-search">
            <span>⌕</span>
            <input placeholder="Buscar pessoas, agents ou rooms" aria-label="Buscar conversas" />
          </label>
          {visibleConversations.map((conversation) => (
            <button
              key={conversation.id}
              className={selectedId === conversation.id ? "is-selected" : ""}
              onClick={() => setSelectedId(conversation.id)}
            >
              <Avatar initials={conversation.initials} color={conversation.color} small />
              <span>
                <b>{conversation.name}</b>
                <small>{conversation.meta}</small>
                <em>{conversation.preview}</em>
              </span>
              <span className="conversation-meta">
                <small>{conversation.time}</small>
                {conversation.unread > 0 && <b>{conversation.unread}</b>}
              </span>
            </button>
          ))}
        </aside>
        <section className="message-thread">
          <header>
            <Avatar initials={selectedConversation.initials} color={selectedConversation.color} />
            <div><h2>{selectedConversation.name}</h2><p><StatusDot status="Ready" /> {selectedConversation.meta} · {selectedConversation.mode}</p></div>
            <button onClick={onProject}>Abrir contexto ↗</button>
          </header>
          <div className="thread-context">
            <span>⌁ Contexto fixado</span>
            <b>Nexus Commerce / WI-298 / Rollout guard</b>
            <button onClick={onProject}>ver WorkItem</button>
          </div>
          <div className="thread-body">
            <div className="thread-marker"><span>Hoje · 09:42</span></div>
            <article className="message-bubble agent-message">
              <Avatar initials="AT" color="#ddf5a1" small />
              <div>
                <header><b>Atlas</b><span>Agent · via Claude Code CLI</span><time>09:42</time></header>
                <p>Fechei a implementação do rollout guard. Os 248 testes passaram e o forecast do canary ficou em 98,6%.</p>
                <div className="message-action-card">
                  <span className="artifact-symbol">PR</span>
                  <span><small>OUTPUT VINCULADO</small><b>PR #482 · rollout-guard</b><em>6/6 checks · a18f9d2 · ready for review</em></span>
                  <button onClick={() => notify("PR #482 aberto")}>Abrir ↗</button>
                </div>
                <footer><button>↩ Responder</button><button onClick={onOutput}>▤ Ver artifacts</button><span>Contexto capturado no ledger</span></footer>
              </div>
            </article>
            <article className="message-bubble human-message">
              <Avatar initials="RC" color="#d7defa" small />
              <div>
                <header><b>Você</b><span>Owner</span><time>09:46</time></header>
                <p>Antes de liberar, compare a estratégia 10 → 40 → 100 com o rollback imediato e explique o reason why.</p>
              </div>
            </article>
            <article className="message-bubble agent-message">
              <Avatar initials="AT" color="#ddf5a1" small />
              <div>
                <header><b>Atlas</b><span>Agent · grounded answer</span><time>09:47</time></header>
                <p>Recomendo o rollout progressivo: reduz blast radius, preserva sinal estatístico e mantém rollback abaixo de 2 minutos. Registrei alternativas, evidências e premissas no Decision Ledger.</p>
                <div className="reason-chip"><span>WHY</span> DEC-204 · 4 evidências · hash verificado</div>
              </div>
            </article>
            {sentMessages.map((message, index) => (
              <article className="message-bubble human-message" key={`${message}-${index}`}>
                <Avatar initials="RC" color="#d7defa" small />
                <div><header><b>Você</b><span>agora</span></header><p>{message}</p></div>
              </article>
            ))}
          </div>
          <form className="message-composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
            <div className="composer-mode"><span>CONVERSA</span><em>Nenhuma ação será executada sem um intent explícito</em></div>
            <textarea
              data-testid="message-composer"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Mensagem para ${selectedConversation.name}… use @, /skill ou anexe um output`}
              aria-label={`Mensagem para ${selectedConversation.name}`}
            />
            <footer>
              <div><button type="button" onClick={() => notify("Seletor de artifact aberto")}>＋ Artifact</button><button type="button">/ Skill</button><button type="button">@ Contexto</button></div>
              <button className="primary-button compact" data-testid="send-message" type="submit">Enviar ↗</button>
            </footer>
          </form>
        </section>
        <aside className="conversation-context">
          <span className="eyebrow">SESSION CONTEXT</span>
          <div className="context-identity">
            <Avatar initials={selectedConversation.initials} color={selectedConversation.color} />
            <span><b>{selectedConversation.name}</b><small>{selectedConversation.mode}</small></span>
          </div>
          <dl>
            <div><dt>Project</dt><dd>Nexus Commerce</dd></div>
            <div><dt>Objective</dt><dd>Checkout abandonment ≤ 31%</dd></div>
            <div><dt>Memory</dt><dd>Project + team · 38 items</dd></div>
            <div><dt>Authority</dt><dd>A2 · propose, code, test</dd></div>
            <div><dt>Escalation</dt><dd>R3+ → Rafael</dd></div>
          </dl>
          <div className="context-note"><b>Boundaries</b><p>Mensagens não autorizam ações. Tool calls exigem ActionIntent, policy check e evidence.</p></div>
          <button className="outline-button" onClick={() => notify("Agent Room aberto")}>Abrir Agent Room</button>
        </aside>
      </div>
    </div>
  );
}

function RoomsView({
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

function LedgerView({ notify }: { notify: (message: string) => void }) {
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
  const latestIntent = liveState?.intents[0];

  const refreshLiveState = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/governance/intents", {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error("live governance unavailable");
    }
    setLiveState((await response.json()) as LiveGovernanceState);
    setLiveError("");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/governance/intents", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("live governance unavailable");
        }
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
  }, []);

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
      await refreshLiveState();
      notify(
        action === "propose"
          ? "ActionIntent real proposto e encadeado"
          : action === "approve"
            ? "Aprovação humana vinculada ao payload"
            : "Efeito simulado executado com receipt",
      );
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
              liveState?.verification.valid
                ? "is-healthy"
                : liveState
                  ? "is-broken"
                  : ""
            }`}
          >
            {liveError
              ? "Unavailable"
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
            <b>{latestIntent?.status ?? "No intent yet"}</b>
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
            disabled={livePending || latestIntent?.status !== "proposed"}
            onClick={() => runLiveAction("approve")}
          >
            Aprovar como humano
          </button>
          <button
            className="primary-button compact"
            disabled={livePending || latestIntent?.status !== "approved"}
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

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const currentContent = (() => {
    if (view === "today") return <TodayView onProject={() => setView("project")} onInbox={() => setView("inbox")} notify={notify} />;
    if (view === "messages") return <MessagesView onProject={() => setView("project")} onOutput={() => setView("outputs")} notify={notify} />;
    if (view === "rooms") return <RoomsView onMessage={() => setView("messages")} notify={notify} />;
    if (view === "project") return <ProjectView notify={notify} />;
    if (view === "inbox") return <InboxView notify={notify} />;
    if (view === "outputs") return <OutputsView notify={notify} />;
    if (view === "releases") return <ReleasesView notify={notify} />;
    if (view === "agents") return <AgentsView onProvider={() => setView("providers")} notify={notify} />;
    if (view === "automations") return <AutomationsView notify={notify} />;
    if (view === "providers") return <ProvidersView notify={notify} />;
    if (view === "ledger") return <LedgerView notify={notify} />;
    return null;
  })();

  if (view === "welcome") {
    return <Onboarding onEnter={() => setView("today")} />;
  }

  return (
    <div className="app-shell">
      <Sidebar view={view} onNavigate={setView} onReset={() => setView("welcome")} />
      <div className="app-main">
        <AppHeader onCommand={() => setCommandOpen(true)} onProvider={() => setView("providers")} />
        {currentContent}
      </div>
      <nav className="mobile-nav">
        {mobileNavIds.map((id) => navItems.find((item) => item.id === id)).filter((item): item is (typeof navItems)[number] => Boolean(item)).map((item) => (
          <button key={item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)}>
            <i>{item.icon}</i><span>{item.label}</span>
          </button>
        ))}
      </nav>
      {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={setView} />}
      {toast && <div className="toast">{toast}<span>✓</span></div>}
    </div>
  );
}
