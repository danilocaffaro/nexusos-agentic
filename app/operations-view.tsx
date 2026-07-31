"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { OperationRead } from "@/src/contracts/operations";
import {
  mapEngineRunOptions,
  readEngineRunOptions,
} from "./engine-run-adapter";
import type { EngineRunOptionView } from "./engine-run-view";
import {
  classifyOperationCreateResponse,
  generateOperationId,
  isAbsoluteExecutionPath,
  mergeOperation,
  operationCreateGate,
  operationErrorMessage,
  operationExecutionCommand,
  operationPublicationLabel,
  operationPublicationReason,
  operationRunStatusLabel,
  readOperationErrorCode,
  readOperationPublishResult,
  readOperationRegistry,
  selectEligibleOperationOptions,
  type OperationCreateRequest,
} from "./operation-view";

export type OperationsWorkspace = {
  projects: Array<{
    id: string;
    name: string;
    status: "active" | "paused" | "archived";
  }>;
  teams: Array<{
    id: string;
    project_id: string;
    name: string;
    status: "active" | "paused" | "archived";
  }>;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    model: string;
    status: "active" | "paused" | "archived";
    teamIds: string[];
  }>;
  workItems: Array<{
    id: string;
    project_id: string;
    ref: string;
    title: string;
    status: string;
  }>;
};

type Props = {
  workspace: OperationsWorkspace | null;
  currentRole: "owner" | "admin" | "member" | "viewer" | undefined;
  notify: (message: string) => void;
  onOpenArtifact: (artifactId: string) => void;
};

type PendingSubmission = {
  operationId: `opr_${string}`;
  request: OperationCreateRequest;
  phase: "submitting" | "outcome_unknown";
};

export function OperationsView({
  workspace,
  currentRole,
  notify,
  onOpenArtifact,
}: Props) {
  const [operations, setOperations] = useState<OperationRead[]>([]);
  const [eligibleOptions, setEligibleOptions] = useState<
    EngineRunOptionView[]
  >([]);
  const [omittedOptions, setOmittedOptions] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [selectedOperationId, setSelectedOperationId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  const [publishingId, setPublishingId] = useState("");
  const [executionPaths, setExecutionPaths] = useState<
    Record<string, string>
  >({});
  const listAbortRef = useRef<AbortController | null>(null);
  const optionsAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const submissionLatchRef = useRef(false);
  const listRequestRef = useRef(0);
  const optionsRequestRef = useRef(0);
  const activeRef = useRef(true);
  const serverOrigin =
    typeof window === "undefined" ? "" : window.location.origin;

  const projects = useMemo(
    () =>
      (workspace?.projects ?? []).filter(
        (project) => project.status === "active",
      ),
    [workspace],
  );
  const projectId = projects.some(
    (project) => project.id === selectedProjectId,
  )
    ? selectedProjectId
    : projects[0]?.id ?? "";
  const workItems = useMemo(
    () =>
      (workspace?.workItems ?? []).filter(
        (item) =>
          item.project_id === projectId &&
          item.status !== "done" &&
          item.status !== "cancelled",
      ),
    [projectId, workspace],
  );
  const workItemId = workItems.some(
    (item) => item.id === selectedWorkItemId,
  )
    ? selectedWorkItemId
    : workItems[0]?.id ?? "";
  const agents = useMemo(() => {
    const activeTeamIds = new Set(
      (workspace?.teams ?? [])
        .filter(
          (team) =>
            team.project_id === projectId && team.status === "active",
        )
        .map((team) => team.id),
    );
    return (workspace?.agents ?? []).filter(
      (agent) =>
        agent.status === "active" &&
        agent.teamIds.some((teamId) => activeTeamIds.has(teamId)),
    );
  }, [projectId, workspace]);
  const agentId = agents.some((agent) => agent.id === selectedAgentId)
    ? selectedAgentId
    : agents[0]?.id ?? "";
  const selectedAgent =
    agents.find((agent) => agent.id === agentId) ?? null;
  const optionId = eligibleOptions.some(
    (option) => option.optionId === selectedOptionId,
  )
    ? selectedOptionId
    : eligibleOptions[0]?.optionId ?? "";
  const selectedOption =
    eligibleOptions.find((option) => option.optionId === optionId) ?? null;
  const selectedOperation =
    operations.find((operation) => operation.id === selectedOperationId) ??
    operations[0] ??
    null;
  const gate = operationCreateGate({
    currentRole,
    projectId,
    workItemId,
    agentId,
    option: selectedOption,
    prompt,
    pending: pending !== null,
  });

  const loadOperations = useCallback(async () => {
    if (currentRole !== "owner") return;
    const requestId = ++listRequestRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/operations", {
        cache: "no-store",
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => null);
      const registry = response.ok ? readOperationRegistry(value) : null;
      if (
        controller.signal.aborted ||
        requestId !== listRequestRef.current
      ) {
        return;
      }
      if (!registry) {
        setError(
          response.status === 403
            ? "Somente o owner pode consultar operações."
            : "A API não retornou o registro de operações esperado.",
        );
        return;
      }
      setOperations(registry.operations);
    } catch (loadError) {
      if (
        loadError instanceof Error &&
        loadError.name === "AbortError"
      ) {
        return;
      }
      if (requestId === listRequestRef.current) {
        setError("Não foi possível consultar operações agora.");
      }
    } finally {
      if (requestId === listRequestRef.current) setLoading(false);
    }
  }, [currentRole]);

  const loadOptions = useCallback(async () => {
    if (currentRole !== "owner") return;
    const requestId = ++optionsRequestRef.current;
    optionsAbortRef.current?.abort();
    const controller = new AbortController();
    optionsAbortRef.current = controller;
    setEligibleOptions([]);
    setOmittedOptions(0);
    try {
      const response = await fetch("/api/runs/engine/options", {
        cache: "no-store",
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => null);
      const payload = response.ok ? readEngineRunOptions(value) : null;
      if (
        controller.signal.aborted ||
        requestId !== optionsRequestRef.current
      ) {
        return;
      }
      if (!payload) {
        setEligibleOptions([]);
        setOmittedOptions(0);
        setError(
          "As opções atuais de runner e engine não puderam ser confirmadas.",
        );
        return;
      }
      const mapped = mapEngineRunOptions(payload);
      const eligible = selectEligibleOperationOptions(mapped);
      setEligibleOptions(eligible);
      setOmittedOptions(mapped.length - eligible.length);
    } catch (optionsError) {
      if (
        optionsError instanceof Error &&
        optionsError.name === "AbortError"
      ) {
        return;
      }
      if (requestId === optionsRequestRef.current) {
        setEligibleOptions([]);
        setOmittedOptions(0);
        setError("Não foi possível confirmar runners e engines agora.");
      }
    }
  }, [currentRole]);

  useEffect(() => {
    activeRef.current = true;
    const initialLoad = window.setTimeout(() => {
      if (currentRole === "owner") {
        void loadOperations();
        void loadOptions();
      }
    }, 0);
    return () => {
      window.clearTimeout(initialLoad);
      activeRef.current = false;
      listAbortRef.current?.abort();
      optionsAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
    };
  }, [currentRole, loadOperations, loadOptions]);

  const submitPending = useCallback(
    async (submission: PendingSubmission) => {
      if (submissionLatchRef.current) return;
      submissionLatchRef.current = true;
      mutationAbortRef.current?.abort();
      const controller = new AbortController();
      mutationAbortRef.current = controller;
      setPending({ ...submission, phase: "submitting" });
      setError("");
      try {
        const response = await fetch("/api/operations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": submission.operationId,
          },
          body: JSON.stringify(submission.request),
          signal: controller.signal,
        });
        const value: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted || !activeRef.current) return;
        const classification = classifyOperationCreateResponse({
          status: response.status,
          value,
          operationId: submission.operationId,
        });
        if (classification.kind === "confirmed") {
          setOperations((current) =>
            mergeOperation(current, classification.result.operation),
          );
          setSelectedOperationId(classification.result.operation.id);
          setPending(null);
          setPrompt("");
          notify(
            classification.result.created
              ? "Operação criada."
              : "Operação idempotente recuperada.",
          );
          return;
        }
        if (classification.kind === "failure_confirmed") {
          setPending(null);
          setError(operationErrorMessage(classification.code));
          return;
        }
        setPending({ ...submission, phase: "outcome_unknown" });
        setError(
          "Resultado desconhecido. Reenvie manualmente a mesma operação; o ID e o body serão preservados.",
        );
      } catch (submitError) {
        if (
          submitError instanceof Error &&
          submitError.name === "AbortError"
        ) {
          return;
        }
        if (activeRef.current) {
          setPending({ ...submission, phase: "outcome_unknown" });
          setError(
            "Resultado desconhecido. Reenvie manualmente a mesma operação; o ID e o body serão preservados.",
          );
        }
      } finally {
        submissionLatchRef.current = false;
      }
    },
    [notify],
  );

  const createOperation = (event: FormEvent) => {
    event.preventDefault();
    if (!gate.canSubmit || !selectedOption) {
      setError(gate.reason);
      return;
    }
    const submission: PendingSubmission = {
      operationId: generateOperationId(),
      request: Object.freeze({
        projectId,
        workItemId,
        agentId,
        assignedRunnerId: selectedOption.assignedRunnerId,
        engine: selectedOption.engine,
        prompt,
      }),
      phase: "submitting",
    };
    void submitPending(submission);
  };

  const publishOperation = async (operation: OperationRead) => {
    if (
      operation.publication.state !== "eligible" ||
      publishingId ||
      currentRole !== "owner"
    ) {
      return;
    }
    setPublishingId(operation.id);
    setError("");
    try {
      const response = await fetch(
        `/api/operations/${operation.id}/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      const value: unknown = await response.json().catch(() => null);
      const result = response.ok
        ? readOperationPublishResult(value, operation.id)
        : null;
      if (!result) {
        const code =
          readOperationErrorCode(value) ?? "operation_publish_rejected";
        setError(operationErrorMessage(code));
        return;
      }
      setOperations((current) => mergeOperation(current, result.operation));
      notify(
        result.published
          ? "Output Markdown publicado."
          : "Output já estava publicado.",
      );
    } catch {
      setError(
        "Não foi possível confirmar a publicação. Atualize a lista antes de tentar novamente.",
      );
    } finally {
      setPublishingId("");
    }
  };

  const refreshAll = () => {
    setError("");
    void loadOperations();
    void loadOptions();
  };

  if (currentRole !== "owner") {
    return (
      <main className="view-page operations-v1-page">
        <OperationsHeader />
        <section className="operations-v1-boundary is-blocked">
          <b>Acesso owner-only</b>
          <p>
            Esta identidade não foi confirmada como owner. Operações não serão
            consultadas nem criadas pelo navegador.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="view-page operations-v1-page">
      <OperationsHeader />
      <section className="operations-v1-boundary">
        <b>Binding persistente e imutável</b>
        <p>
          A criação fixa projeto, work item, agente, modelo, runner e engine.
          O navegador não executa a CLI e não atualiza resultados
          automaticamente. Use o comando no host e depois Atualizar.
        </p>
      </section>

      {error && (
        <div className="operations-v1-alert" role="alert">
          <span>{error}</span>
          {pending?.phase === "outcome_unknown" && (
            <button
              type="button"
              onClick={() => void submitPending(pending)}
            >
              Reenviar mesma operação
            </button>
          )}
        </div>
      )}

      <section className="operations-v1-create">
        <header>
          <span>
            <small>NOVA OPERAÇÃO</small>
            <h2>Defina o trabalho antes de executar</h2>
          </span>
          <strong>OWNER-ONLY</strong>
        </header>
        <form onSubmit={createOperation}>
          <label>
            <span>Projeto</span>
            <select
              value={projectId}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                setSelectedWorkItemId("");
                setSelectedAgentId("");
              }}
            >
              {projects.length === 0 && <option value="">Sem projeto ativo</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Work item</span>
            <select
              value={workItemId}
              onChange={(event) => setSelectedWorkItemId(event.target.value)}
            >
              {workItems.length === 0 && (
                <option value="">Sem work item aberto</option>
              )}
              {workItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.ref} · {item.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Agente do time</span>
            <select
              value={agentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              {agents.length === 0 && (
                <option value="">Sem agente ativo no projeto</option>
              )}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.role}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Modelo do agente · readonly</span>
            <input readOnly value={selectedAgent?.model ?? ""} />
          </label>
          <label>
            <span>Runner + engine elegíveis agora</span>
            <select
              value={optionId}
              onChange={(event) => setSelectedOptionId(event.target.value)}
            >
              {eligibleOptions.length === 0 && (
                <option value="">Nenhuma opção elegível</option>
              )}
              {eligibleOptions.map((option) => (
                <option key={option.optionId} value={option.optionId}>
                  {option.runnerDisplayName} · {option.engine}
                </option>
              ))}
            </select>
            <small>
              {omittedOptions > 0
                ? `${omittedOptions} opção(ões) omitida(s) por não estarem ready, fresh e elegíveis.`
                : "Somente evidência hostReported atual e elegível é oferecida."}
            </small>
          </label>
          <label>
            <span>Engine explícita · readonly</span>
            <input readOnly value={selectedOption?.engine ?? ""} />
          </label>
          <label className="operations-v1-prompt">
            <span>Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Descreva o resultado esperado e os critérios de conclusão."
              rows={7}
            />
            <small>
              {gate.promptBytes}/6000 bytes do usuário. O servidor acrescenta o
              contexto imutável e valida o limite total da engine.
            </small>
          </label>
          <div className="operations-v1-create-foot">
            <p>
              Modelo e engine são escolhas explícitas e independentes. A
              compatibilidade é verificada na execução local e pode falhar.
              Nenhuma ferramenta, MCP, leitura ou mutação adicional é
              concedida por esta tela.
            </p>
            <button
              type="submit"
              disabled={!gate.canSubmit}
              title={gate.canSubmit ? "" : gate.reason}
            >
              {pending?.phase === "submitting"
                ? "Criando…"
                : "Criar operação"}
            </button>
          </div>
        </form>
      </section>

      <section className="operations-v1-registry">
        <header>
          <span>
            <small>REGISTRO PERSISTENTE</small>
            <h2>Operações</h2>
          </span>
          <button type="button" onClick={refreshAll} disabled={loading}>
            {loading ? "Atualizando…" : "Atualizar"}
          </button>
        </header>
        {operations.length === 0 ? (
          <div className="operations-v1-empty">
            <b>Nenhuma operação registrada</b>
            <p>Crie uma operação ou atualize a lista manualmente.</p>
          </div>
        ) : (
          <div className="operations-v1-split">
            <div className="operations-v1-list" role="list">
              {operations.map((operation) => (
                <button
                  type="button"
                  role="listitem"
                  key={operation.id}
                  className={
                    operation.id === selectedOperation?.id ? "is-active" : ""
                  }
                  onClick={() => setSelectedOperationId(operation.id)}
                >
                  <span>
                    <b>{operation.workItem.ref}</b>
                    <small>{operation.workItem.title}</small>
                  </span>
                  <span>
                    <em>{operationRunStatusLabel(operation)}</em>
                    <small>{operationPublicationLabel(operation)}</small>
                  </span>
                </button>
              ))}
            </div>
            {selectedOperation && (
              <OperationDetail
                operation={selectedOperation}
                publishing={publishingId === selectedOperation.id}
                onPublish={() => void publishOperation(selectedOperation)}
                onOpenArtifact={onOpenArtifact}
                notify={notify}
                serverOrigin={serverOrigin}
                executablePath={
                  executionPaths[
                    `${selectedOperation.id}:${selectedOperation.engine}`
                  ] ?? ""
                }
                onExecutablePathChange={(value) =>
                  setExecutionPaths((current) => ({
                    ...current,
                    [`${selectedOperation.id}:${selectedOperation.engine}`]:
                      value,
                  }))
                }
              />
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function OperationsHeader() {
  return (
    <header className="operations-v1-title">
      <span>
        <small>OPERATIONS · OWNER-ONLY · PERSISTENTE</small>
        <h1>Operações</h1>
      </span>
      <p>
        Transforme um work item em execução CLI rastreável e publique apenas
        outputs elegíveis como Markdown.
      </p>
    </header>
  );
}

function OperationDetail({
  operation,
  publishing,
  onPublish,
  onOpenArtifact,
  notify,
  serverOrigin,
  executablePath,
  onExecutablePathChange,
}: {
  operation: OperationRead;
  publishing: boolean;
  onPublish: () => void;
  onOpenArtifact: (artifactId: string) => void;
  notify: (message: string) => void;
  serverOrigin: string;
  executablePath: string;
  onExecutablePathChange: (value: string) => void;
}) {
  const commandReady =
    isAbsoluteExecutionPath(executablePath) && serverOrigin !== "";
  const command = commandReady
    ? operationExecutionCommand({
        engine: operation.engine,
        runId: operation.runId,
        executablePath,
        serverOrigin,
      })
    : `npm run local:engine -- --engine ${operation.engine} --path <caminho-absoluto> --server ${serverOrigin || "<origem-nexusos>"} --run ${operation.runId}`;
  const publicationReason = operationPublicationReason(operation);
  const published =
    operation.publication.state === "published"
      ? operation.publication
      : null;

  const copyCommand = async () => {
    if (!commandReady) return;
    try {
      await navigator.clipboard.writeText(command);
      notify("Comando copiado.");
    } catch {
      notify("Não foi possível copiar; selecione o comando manualmente.");
    }
  };

  return (
    <article className="operations-v1-detail">
      <header>
        <span>
          <small>{operation.id}</small>
          <h3>
            {operation.workItem.ref} · {operation.workItem.title}
          </h3>
        </span>
        <strong>{operationRunStatusLabel(operation)}</strong>
      </header>
      <dl>
        <div>
          <dt>Agente</dt>
          <dd>
            {operation.agent.name} · {operation.agent.role}
          </dd>
        </div>
        <div>
          <dt>Modelo</dt>
          <dd>{operation.agent.model}</dd>
        </div>
        <div>
          <dt>Runner</dt>
          <dd>{operation.assignedRunnerId}</dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>{operation.engine}</dd>
        </div>
        <div>
          <dt>Run ID</dt>
          <dd>{operation.runId}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>
            <time dateTime={operation.run.deadlineAt}>
              {displayTimestamp(operation.run.deadlineAt)}
            </time>
          </dd>
        </div>
      </dl>
      <section className="operations-v1-command">
        <span>
          <b>Execute no host do runner</b>
          <small>
            Informe o executável absoluto desta engine. O path permanece
            somente nesta tela; server e run ID entram no comando.
          </small>
        </span>
        <label>
          <span>Caminho absoluto do CLI</span>
          <input
            value={executablePath}
            onChange={(event) => onExecutablePathChange(event.target.value)}
            placeholder={
              operation.engine === "claude_code_cli"
                ? "/opt/homebrew/bin/claude"
                : "/opt/homebrew/bin/codex"
            }
            autoComplete="off"
            spellCheck={false}
          />
          {executablePath && !isAbsoluteExecutionPath(executablePath) && (
            <small role="alert">
              Informe um path POSIX absoluto, sem espaços externos.
            </small>
          )}
        </label>
        <code>{command}</code>
        <button
          type="button"
          onClick={() => void copyCommand()}
          disabled={!commandReady}
          title={
            commandReady
              ? ""
              : "Preencha um caminho absoluto antes de copiar."
          }
        >
          Copiar comando
        </button>
      </section>
      {operation.receipt && (
        <section className="operations-v1-receipt">
          <b>Receipt confirmado</b>
          <p>
            {operation.receipt.status} · {operation.receipt.reason} · stdout{" "}
            {operation.receipt.stdout.bytes} bytes
            {operation.receipt.stdout.truncated ? " · truncado" : ""}
          </p>
          <small>SHA-256 {operation.receipt.receiptSha256}</small>
        </section>
      )}
      <footer className="operations-v1-publication">
        <span>
          <b>{operationPublicationLabel(operation)}</b>
          <small>
            {publicationReason ||
              (operation.publication.state === "pending"
                ? "Execute no host e use Atualizar. Não há polling automático."
                : operation.publication.state === "eligible"
                  ? "O stdout confirmado pode virar a versão 1 de um output Markdown."
                  : published
                    ? `Versão ${published.versionNumber} · ${published.contentHash}`
                    : "")}
          </small>
        </span>
        {operation.publication.state === "eligible" && (
          <button type="button" onClick={onPublish} disabled={publishing}>
            {publishing ? "Publicando…" : "Publicar output Markdown"}
          </button>
        )}
        {published && (
          <button
            type="button"
            onClick={() => onOpenArtifact(published.artifactId)}
          >
            Abrir output
          </button>
        )}
      </footer>
    </article>
  );
}

function displayTimestamp(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)}Z`;
}
