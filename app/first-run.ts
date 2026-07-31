export const FIRST_RUN_STEPS = [
  "Workspace e responsável",
  "Primeiro projeto",
  "Primeiro time",
  "Revisar e criar",
] as const;

export type FirstRunStep = 0 | 1 | 2 | 3;

export type FirstRunDraft = {
  workspaceName: string;
  ownerName: string;
  projectName: string;
  projectObjective: string;
  teamName: string;
  teamMission: string;
};

export type FirstRunField = keyof FirstRunDraft;
export type FirstRunErrors = Partial<Record<FirstRunField, string>>;

export type SetupRequest = {
  workspaceName: string;
  ownerName: string;
  project: {
    name: string;
    objective: string;
  };
  team: {
    name: string;
    mission: string;
  };
};

export type WorkspaceBootstrap = {
  organization: {
    id: string;
    name: string;
    slug?: string;
  };
  currentPrincipal: {
    id: string;
    displayName: string;
    role?: "owner" | "admin" | "member" | "viewer";
  };
  setupRequired: boolean;
};

const FIELD_RULES: Readonly<
  Record<
    FirstRunField,
    Readonly<{ label: string; maximum: number; step: Exclude<FirstRunStep, 3> }>
  >
> = {
  workspaceName: { label: "o nome do workspace", maximum: 80, step: 0 },
  ownerName: { label: "seu nome", maximum: 80, step: 0 },
  projectName: { label: "o nome do projeto", maximum: 80, step: 1 },
  projectObjective: {
    label: "o objetivo do projeto",
    maximum: 500,
    step: 1,
  },
  teamName: { label: "o nome do time", maximum: 80, step: 2 },
  teamMission: { label: "a missão do time", maximum: 500, step: 2 },
};

export function blankFirstRunDraft(): FirstRunDraft {
  return {
    workspaceName: "",
    ownerName: "",
    projectName: "",
    projectObjective: "",
    teamName: "",
    teamMission: "",
  };
}

export function validateFirstRunStep(
  draft: FirstRunDraft,
  step: FirstRunStep,
): FirstRunErrors {
  const errors: FirstRunErrors = {};
  for (const field of Object.keys(FIELD_RULES) as FirstRunField[]) {
    const rule = FIELD_RULES[field];
    if (step !== 3 && rule.step !== step) continue;
    const value = draft[field].trim();
    if (!value) {
      errors[field] = `Informe ${rule.label}.`;
    } else if (value.length > rule.maximum) {
      errors[field] =
        `Use no máximo ${rule.maximum} caracteres para ${rule.label}.`;
    }
  }
  return errors;
}

export function buildSetupRequest(
  draft: FirstRunDraft,
): Readonly<
  | { ok: true; request: SetupRequest }
  | { ok: false; errors: FirstRunErrors }
> {
  const errors = validateFirstRunStep(draft, 3);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    request: {
      workspaceName: draft.workspaceName.trim(),
      ownerName: draft.ownerName.trim(),
      project: {
        name: draft.projectName.trim(),
        objective: draft.projectObjective.trim(),
      },
      team: {
        name: draft.teamName.trim(),
        mission: draft.teamMission.trim(),
      },
    },
  };
}

export function readWorkspaceBootstrap(
  value: unknown,
): WorkspaceBootstrap | null {
  if (!isRecord(value)) return null;
  const organization = value.organization;
  const currentPrincipal = value.currentPrincipal;
  if (
    !isRecord(organization) ||
    typeof organization.id !== "string" ||
    typeof organization.name !== "string" ||
    (organization.slug !== undefined &&
      typeof organization.slug !== "string") ||
    !isRecord(currentPrincipal) ||
    typeof currentPrincipal.id !== "string" ||
    typeof currentPrincipal.displayName !== "string" ||
    (currentPrincipal.role !== undefined &&
      !["owner", "admin", "member", "viewer"].includes(
        String(currentPrincipal.role),
      )) ||
    typeof value.setupRequired !== "boolean"
  ) {
    return null;
  }
  return {
    organization: {
      id: organization.id,
      name: organization.name,
      ...(organization.slug === undefined ? {} : { slug: organization.slug }),
    },
    currentPrincipal: {
      id: currentPrincipal.id,
      displayName: currentPrincipal.displayName,
      ...(currentPrincipal.role === undefined
        ? {}
        : {
            role: currentPrincipal.role as
              | "owner"
              | "admin"
              | "member"
              | "viewer",
          }),
    },
    setupRequired: value.setupRequired,
  };
}

export function setupErrorMessage(code?: string): string {
  const messages: Readonly<Record<string, string>> = {
    setup_already_completed:
      "Este workspace já foi configurado. Vamos confirmar o estado atual.",
    setup_not_available:
      "A configuração inicial não está disponível para esta identidade.",
    invalid_setup_request:
      "Revise os campos antes de criar o workspace.",
    invalid_setup_body:
      "Revise os campos antes de criar o workspace.",
    workspace_slug_unavailable:
      "Já existe um workspace com este nome. Escolha outro nome.",
    workspace_owner_required:
      "Apenas o responsável inicial pode concluir esta configuração.",
    setup_conflict:
      "O workspace mudou durante a configuração. Vamos confirmar o estado atual.",
  };
  return (
    messages[code ?? ""] ??
    "Não foi possível concluir a configuração. Nenhum reenvio será feito sem confirmação."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
