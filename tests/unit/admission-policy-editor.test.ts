import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdmissionPolicyEditor,
  policyDraftFrom,
  policyDraftPutInput,
  rebasePolicyDraft,
  togglePolicyCapability,
  type AdmissionPolicyDraft,
} from "../../app/admission-policy-editor";
import {
  isAmbiguousPolicyMutation,
  policyLoadFailure,
  policyMutationMessage,
} from "../../app/admission-policy-panel";
import type {
  RunnerAdmissionPolicy,
  RunnerCapabilityName,
} from "../../src/contracts/runners";

const configuredPolicy: RunnerAdmissionPolicy = {
  version: 3,
  source: "configured",
  capabilityFreshnessSeconds: 7_200,
  allowedCapabilities: ["bubblewrap", "podman"],
  updatedAt: "2026-07-26T12:00:00.000Z",
  updatedBy: "principal-owner",
};

const editorHtml = (
  draft: AdmissionPolicyDraft,
  submitting = false,
) =>
  renderToStaticMarkup(
    createElement(AdmissionPolicyEditor, {
      draft,
      submitting,
      onChange: () => undefined,
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }),
  );

test("opens from immutable server facts and freezes the base version", () => {
  const policy: RunnerAdmissionPolicy = {
    ...configuredPolicy,
    allowedCapabilities: ["bubblewrap", "podman"],
  };
  const draft = policyDraftFrom(policy);
  policy.allowedCapabilities.push("docker");
  assert.deepEqual(draft, {
    baseVersion: 3,
    freshnessInput: "7200",
    allowedCapabilities: ["bubblewrap", "podman"],
    conflict: null,
    submitError: "",
    permissionLost: false,
  });
});

test("toggles capabilities immutably in the canonical closed order", () => {
  const original = policyDraftFrom({
    ...configuredPolicy,
    allowedCapabilities: ["podman"],
  });
  const withDocker = togglePolicyCapability(original, "docker");
  const denyAll = togglePolicyCapability(
    togglePolicyCapability(withDocker, "podman"),
    "docker",
  );
  assert.deepEqual(original.allowedCapabilities, ["podman"]);
  assert.deepEqual(withDocker.allowedCapabilities, ["docker", "podman"]);
  assert.deepEqual(denyAll.allowedCapabilities, []);
});

test("builds the exact compare-and-swap body and validates both bounds", () => {
  const draft = policyDraftFrom(configuredPolicy);
  assert.deepEqual(policyDraftPutInput(draft), {
    ok: true,
    input: {
      expectedVersion: 3,
      capabilityFreshnessSeconds: 7_200,
      allowedCapabilities: ["bubblewrap", "podman"],
    },
  });
  for (const freshnessInput of ["3599", "2592001", "7200.5", "NaN"]) {
    assert.equal(
      policyDraftPutInput({ ...draft, freshnessInput }).ok,
      false,
    );
  }
  assert.equal(
    policyDraftPutInput({
      ...draft,
      allowedCapabilities: ["podman", "podman"],
    }).ok,
    false,
  );
  assert.equal(
    policyDraftPutInput({
      ...draft,
      allowedCapabilities: [
        "invented" as RunnerCapabilityName,
      ],
    }).ok,
    false,
  );
});

test("rebases only after an explicit conflict action and preserves fields", () => {
  const conflicted: AdmissionPolicyDraft = {
    ...policyDraftFrom(configuredPolicy),
    freshnessInput: "86401",
    allowedCapabilities: [],
    conflict: { serverVersion: 4 },
    submitError: "preserved until the click",
  };
  const rebased = rebasePolicyDraft(conflicted);
  assert.equal(conflicted.baseVersion, 3);
  assert.equal(conflicted.conflict?.serverVersion, 4);
  assert.deepEqual(rebased, {
    ...conflicted,
    baseVersion: 4,
    conflict: null,
    submitError: "",
  });
  assert.equal(rebasePolicyDraft(rebased), rebased);
});

test("renders a governed editor with all seven choices and no silent reset", () => {
  const html = editorHtml(policyDraftFrom(configuredPolicy));
  assert.match(html, /COMPARE-AND-SWAP/u);
  assert.match(html, /BASE CONGELADA · v3/u);
  assert.match(html, /value="7200"/u);
  assert.equal(
    (html.match(/name="allowedCapabilities"/gu) ?? []).length,
    7,
  );
  assert.match(html, /Salvar sobre a v3/u);
  assert.match(html, />Cancelar</u);
  assert.doesNotMatch(html, /restaurar|padrão do sistema/iu);
});

test("renders a conflict as an explicit preserved-draft resubmission", () => {
  const html = editorHtml({
    ...policyDraftFrom(configuredPolicy),
    freshnessInput: "86401",
    allowedCapabilities: [],
    conflict: { serverVersion: 4 },
  });
  assert.match(html, /role="alert"/u);
  assert.match(html, /rascunho foi preservado/iu);
  assert.match(html, /value="86401"/u);
  assert.match(html, /DENY-ALL EXPLÍCITO/u);
  assert.match(html, /Reenviar sobre a v4/u);
});

test("renders lost permission as read-only and removes the submit path", () => {
  const html = editorHtml({
    ...policyDraftFrom(configuredPolicy),
    permissionLost: true,
    submitError: "Sua permissão foi removida.",
  });
  assert.match(html, /somente leitura/iu);
  assert.match(html, /disabled=""/u);
  assert.match(html, /Fechar edição/u);
  assert.doesNotMatch(html, /type="submit"/u);
});

test("keeps cancel available so a pending request can be aborted", () => {
  const html = editorHtml(policyDraftFrom(configuredPolicy), true);
  assert.match(html, />Cancelar</u);
  assert.doesNotMatch(
    html,
    /<button[^>]*disabled[^>]*>Cancelar<\/button>/u,
  );
  assert.match(html, /Gravando decisão/u);
});

test("classifies terminal load failures and preserves safe mutation copy", () => {
  assert.deepEqual(policyLoadFailure(401, "authentication_required"), {
    message: "Sua sessão precisa ser renovada.",
    retryable: false,
  });
  assert.deepEqual(
    policyLoadFailure(403, "workspace_membership_required"),
    {
      message: "Você não possui mais acesso a esta política.",
      retryable: false,
    },
  );
  assert.equal(policyLoadFailure(503, null).retryable, true);
  assert.match(
    policyMutationMessage("policy_invalid"),
    /resultado desta gravação não foi confirmado/iu,
  );
  assert.match(
    policyMutationMessage("conflict_refresh_failed"),
    /rascunho foi preservado/iu,
  );
  assert.equal(
    isAmbiguousPolicyMutation("admission_policy_failed"),
    true,
  );
  assert.equal(isAmbiguousPolicyMutation("policy_write_failed"), true);
  assert.equal(isAmbiguousPolicyMutation("policy_invalid"), true);
  assert.equal(
    isAmbiguousPolicyMutation("invalid_admission_policy"),
    false,
  );
  assert.equal(
    isAmbiguousPolicyMutation("authentication_required"),
    false,
  );
});

test("panel gates editing on server authority, pauses polling, and has one PUT site", () => {
  const source = readFileSync(
    new URL("../../app/admission-policy-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /response\?\.viewerCanEditPolicy && !draft/u,
  );
  assert.match(source, /!editorOpenRef\.current/u);
  assert.match(source, /expectedVersion \+ 1/u);
  assert.match(source, /parsed\.policy\.source !== "configured"/u);
  assert.equal((source.match(/method: "PUT"/gu) ?? []).length, 1);
  assert.match(source, /refreshFactsAfterConflict/u);
  assert.match(source, /refreshFactsAfterPermissionLoss/u);
  assert.match(source, /refreshFactsAfterAmbiguousResult/u);
  const openEditorSource = source.slice(
    source.indexOf("const openEditor"),
    source.indexOf("const closeEditor"),
  );
  assert.match(openEditorSource, /requestIdRef\.current \+= 1/u);
  assert.match(
    openEditorSource,
    /controllerRef\.current\?\.abort\(\)/u,
  );
  assert.match(
    openEditorSource,
    /!response\?\.viewerCanEditPolicy \|\| loadError/u,
  );
  assert.match(source, /disabled=\{!!loadError\}/u);
  assert.match(
    source,
    /return \{ \.\.\.merged, viewerCanEditPolicy: false \}/u,
  );
  assert.match(
    source,
    /editButtonRef\.current \?\? panelRef\.current/u,
  );
});
