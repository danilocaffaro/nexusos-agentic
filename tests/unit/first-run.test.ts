import assert from "node:assert/strict";
import test from "node:test";

import {
  blankFirstRunDraft,
  buildSetupRequest,
  readWorkspaceBootstrap,
  setupErrorMessage,
  validateFirstRunStep,
  type FirstRunDraft,
} from "../../app/first-run";

const validDraft: FirstRunDraft = {
  workspaceName: "North Star",
  ownerName: "Ana Silva",
  projectName: "Lançamento",
  projectObjective: "Colocar a primeira versão em produção.",
  teamName: "Produto",
  teamMission: "Entregar e aprender com usuários reais.",
};

test("first-run validation is step-scoped and rejects blank values", () => {
  const draft = blankFirstRunDraft();
  assert.deepEqual(validateFirstRunStep(draft, 0), {
    workspaceName: "Informe o nome do workspace.",
    ownerName: "Informe seu nome.",
  });
  assert.deepEqual(validateFirstRunStep(draft, 1), {
    projectName: "Informe o nome do projeto.",
    projectObjective: "Informe o objetivo do projeto.",
  });
  assert.deepEqual(validateFirstRunStep(draft, 2), {
    teamName: "Informe o nome do time.",
    teamMission: "Informe a missão do time.",
  });
  assert.equal(Object.keys(validateFirstRunStep(validDraft, 3)).length, 0);
});

test("setup request trims values and preserves the exact public contract", () => {
  const result = buildSetupRequest({
    ...validDraft,
    workspaceName: "  North Star  ",
    ownerName: " Ana Silva ",
    projectName: " Lançamento ",
    projectObjective: " Colocar a primeira versão em produção. ",
    teamName: " Produto ",
    teamMission: " Entregar e aprender com usuários reais. ",
  });
  assert.deepEqual(result, {
    ok: true,
    request: {
      workspaceName: "North Star",
      ownerName: "Ana Silva",
      project: {
        name: "Lançamento",
        objective: "Colocar a primeira versão em produção.",
      },
      team: {
        name: "Produto",
        mission: "Entregar e aprender com usuários reais.",
      },
    },
  });
});

test("setup request cannot be built with overlong or missing values", () => {
  const result = buildSetupRequest({
    ...validDraft,
    workspaceName: "x".repeat(81),
    teamMission: " ",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errors.workspaceName ?? "", /80 caracteres/u);
  assert.equal(result.errors.teamMission, "Informe a missão do time.");
});

test("workspace bootstrap accepts only authenticated first-run metadata", () => {
  assert.deepEqual(
    readWorkspaceBootstrap({
      organization: {
        id: "org_1",
        slug: "north-star",
        name: "North Star",
      },
      currentPrincipal: {
        id: "prn_1",
        displayName: "Ana Silva",
        role: "owner",
      },
      setupRequired: true,
    }),
    {
      organization: {
        id: "org_1",
        slug: "north-star",
        name: "North Star",
      },
      currentPrincipal: {
        id: "prn_1",
        displayName: "Ana Silva",
        role: "owner",
      },
      setupRequired: true,
    },
  );
  assert.equal(
    readWorkspaceBootstrap({
      organization: { id: "org_1", name: "North Star" },
      currentPrincipal: { id: "prn_1", displayName: "Ana" },
      setupRequired: "yes",
    }),
    null,
  );
});

test("setup errors remain bounded and do not reflect server input", () => {
  assert.equal(
    setupErrorMessage("setup_already_completed"),
    "Este workspace já foi configurado. Vamos confirmar o estado atual.",
  );
  assert.equal(
    setupErrorMessage("<script>"),
    "Não foi possível concluir a configuração. Nenhum reenvio será feito sem confirmação.",
  );
});
