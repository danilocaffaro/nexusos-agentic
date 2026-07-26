"use client";

import { useMemo, useState } from "react";

type View =
  | "welcome"
  | "today"
  | "project"
  | "inbox"
  | "agents"
  | "automations"
  | "providers";

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

const navItems: Array<{ id: View; label: string; icon: string }> = [
  { id: "today", label: "Today", icon: "⌂" },
  { id: "inbox", label: "Inbox", icon: "◇" },
  { id: "project", label: "Projetos", icon: "▦" },
  { id: "agents", label: "Time híbrido", icon: "◎" },
  { id: "automations", label: "Automações", icon: "↻" },
  { id: "providers", label: "Provedores", icon: "⌁" },
];

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
        <span className="nav-label">OPERAR</span>
        {navItems.map((item) => (
          <button
            key={item.id}
            data-testid={`nav-${item.id}`}
            className={view === item.id ? "is-active" : ""}
            onClick={() => onNavigate(item.id)}
          >
            <i>{item.icon}</i>
            <span>{item.label}</span>
            {item.id === "inbox" && <b className="nav-count">6</b>}
          </button>
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

function AgentsView({ onProvider, notify }: { onProvider: () => void; notify: (message: string) => void }) {
  return (
    <div className="view-page agents-page" data-testid="agents-view">
      <div className="page-heading">
        <div><span className="eyebrow">HYBRID TEAM RUNTIME</span><h1>Seu time, como um sistema.</h1><p>14 humanos e 12 agents trabalhando em 3 projetos.</p></div>
        <button className="primary-button compact" onClick={() => notify("Fluxo de novo agente aberto")}>＋ Novo agente</button>
      </div>
      <section className="team-overview">
        <div><span className="section-number">01</span><span><span className="eyebrow">CHECKOUT EVOLUTION</span><h2>4 humans + 4 agents</h2></span></div>
        <div className="team-capacity">
          <span><b>72%</b>capacity</span>
          <span><b>94%</b>quality</span>
          <span><b>$184</b>week cost</span>
        </div>
      </section>
      <div className="agent-directory">
        {agents.map((agent) => (
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
              <span><small>SKILLS</small><b>{agent.skills}</b></span>
              <span><small>MEMORY</small><b>{agent.memory}</b></span>
              <span><small>AUTONOMY</small><b>A2</b></span>
              <span><small>QUALITY</small><b>94%</b></span>
            </div>
            <footer>
              <span>Owner · Rafael</span>
              <button onClick={() => notify(`${agent.name} Agent Room aberto`)}>Abrir Agent Room →</button>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
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
    ["Criar WorkItem em Nexus Commerce", "project", "＋"],
    ["Revisar decisões pendentes", "inbox", "◇"],
    ["Ver agents com sessão CLI", "providers", "⌁"],
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

  const currentContent = useMemo(() => {
    if (view === "today") return <TodayView onProject={() => setView("project")} onInbox={() => setView("inbox")} notify={notify} />;
    if (view === "project") return <ProjectView notify={notify} />;
    if (view === "inbox") return <InboxView notify={notify} />;
    if (view === "agents") return <AgentsView onProvider={() => setView("providers")} notify={notify} />;
    if (view === "automations") return <AutomationsView notify={notify} />;
    if (view === "providers") return <ProvidersView notify={notify} />;
    return null;
  }, [view]);

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
        {navItems.slice(0, 5).map((item) => (
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
