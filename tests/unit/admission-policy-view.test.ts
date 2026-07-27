import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdmissionPolicyView,
  admissionPolicyViewState,
  formatPolicyDuration,
  mergeRunnerAdmissionPolicyResponse,
  readRunnerAdmissionPolicyResponse,
} from "../../app/admission-policy-view";
import { RunnerAdmissionPolicyPanel } from "../../app/admission-policy-panel";
import type {
  RunnerAdmissionPolicy,
  RunnerAdmissionPolicyResponse,
} from "../../src/contracts/runners";

const configured = (
  allowedCapabilities: RunnerAdmissionPolicy["allowedCapabilities"],
): RunnerAdmissionPolicyResponse => ({
  policy: {
    version: 3,
    source: "configured",
    capabilityFreshnessSeconds: 7_200,
    engineFreshnessSeconds: 10_800,
    allowedCapabilities,
    updatedAt: "2026-07-26T12:00:00.000Z",
    updatedBy: "principal-owner",
  },
  viewerCanEditPolicy: true,
});

test("renders the virtual default as an unrecorded state", () => {
  const response: RunnerAdmissionPolicyResponse = {
    policy: {
      version: 0,
      source: "default",
      capabilityFreshnessSeconds: 86_400,
      engineFreshnessSeconds: 86_400,
      allowedCapabilities: [
        "node_permission_model",
        "bubblewrap",
        "landlock",
        "seccomp",
        "user_namespace",
        "docker",
        "podman",
      ],
    },
    viewerCanEditPolicy: false,
  };
  const html = renderToStaticMarkup(
    createElement(AdmissionPolicyView, { response }),
  );
  assert.equal(admissionPolicyViewState(response.policy), "default");
  assert.match(html, /PADRÃO VIRTUAL · v0/u);
  assert.match(html, /nenhuma decisão foi gravada/iu);
  assert.match(html, /padrão virtual · não persistido/u);
  assert.match(html, /Janela do inventário de motores/u);
  assert.match(html, /somente leitura neste acesso/u);
  assert.equal((html.match(/PERMITIDA/gu) ?? []).length, 7);
  assert.doesNotMatch(html, /Editar política/u);
});

test("renders a configured allow-list and its lease boundary", () => {
  const response = configured(["bubblewrap", "podman"]);
  const html = renderToStaticMarkup(
    createElement(AdmissionPolicyView, { response }),
  );
  assert.equal(admissionPolicyViewState(response.policy), "allow-list");
  assert.match(html, /ALLOW-LIST CONFIGURADA · v3/u);
  assert.match(html, /2 de 7 capacidades/u);
  assert.equal((html.match(/PERMITIDA/gu) ?? []).length, 2);
  assert.equal((html.match(/NEGADA/gu) ?? []).length, 5);
  assert.match(html, /Leases já ativas mantêm os pins/u);
  assert.match(html, /não revoga trabalho em curso/u);
  assert.match(
    html,
    /owner\/admin · confirmada pelo servidor/u,
  );
  assert.doesNotMatch(
    html,
    /<(button|form|input|select|textarea)/u,
  );
});

test("renders configured deny-all without blocking assignment-only", () => {
  const response = configured([]);
  const html = renderToStaticMarkup(
    createElement(AdmissionPolicyView, { response }),
  );
  assert.equal(admissionPolicyViewState(response.policy), "deny-all");
  assert.match(html, /DENY-ALL CONFIGURADO · v3/u);
  assert.match(html, /toda capacidade exigida/u);
  assert.match(
    html,
    /Atribuições sem capacidade exigida continuam independentes/u,
  );
  assert.equal((html.match(/NEGADA/gu) ?? []).length, 7);
});

test("validates the closed policy response and rejects contradictions", () => {
  const response = configured(["bubblewrap"]);
  assert.deepEqual(readRunnerAdmissionPolicyResponse(response), response);
  assert.equal(
    readRunnerAdmissionPolicyResponse({
      ...response,
      viewerCanEditPolicy: "yes",
    }),
    null,
  );
  assert.equal(
    readRunnerAdmissionPolicyResponse({
      ...response,
      policy: { ...response.policy, version: 0 },
    }),
    null,
  );
  assert.equal(
    readRunnerAdmissionPolicyResponse({
      policy: {
        version: 0,
        source: "default",
        capabilityFreshnessSeconds: 3_600,
        engineFreshnessSeconds: 86_400,
        allowedCapabilities: [
          "node_permission_model",
          "bubblewrap",
          "landlock",
          "seccomp",
          "user_namespace",
          "docker",
          "podman",
        ],
      },
      viewerCanEditPolicy: false,
    }),
    null,
  );
  assert.equal(
    readRunnerAdmissionPolicyResponse({
      ...response,
      policy: {
        ...response.policy,
        allowedCapabilities: ["bubblewrap", "bubblewrap"],
      },
    }),
    null,
  );
  for (const capabilityFreshnessSeconds of [3_599, 2_592_001]) {
    assert.equal(
      readRunnerAdmissionPolicyResponse({
        ...response,
        policy: {
          ...response.policy,
          capabilityFreshnessSeconds,
        },
      }),
      null,
    );
  }
  for (const engineFreshnessSeconds of [3_599, 2_592_001]) {
    assert.equal(
      readRunnerAdmissionPolicyResponse({
        ...response,
        policy: {
          ...response.policy,
          engineFreshnessSeconds,
        },
      }),
      null,
    );
  }
  assert.equal(
    readRunnerAdmissionPolicyResponse({
      ...response,
      policy: {
        ...response.policy,
        allowedCapabilities: ["invented"],
      },
    }),
    null,
  );
  assert.equal(
    readRunnerAdmissionPolicyResponse({
      ...response,
      policy: {
        ...response.policy,
        updatedAt: "not-a-date",
      },
    }),
    null,
  );
  assert.equal(
    readRunnerAdmissionPolicyResponse({
      ...response,
      policy: {
        ...response.policy,
        updatedBy: "",
      },
    }),
    null,
  );
});

test("renders the exact freshness window without rounding down", () => {
  assert.equal(formatPolicyDuration(7_199), "1h 59min 59s");
  assert.equal(formatPolicyDuration(5_400), "1h 30min");
  assert.equal(formatPolicyDuration(88_200), "1d 30min");
  assert.equal(formatPolicyDuration(86_400), "1d");
});

test("never combines an older policy with its stale permission flag", () => {
  const current = configured(["bubblewrap"]);
  const older: RunnerAdmissionPolicyResponse = {
    policy: {
      version: 2,
      source: "configured",
      capabilityFreshnessSeconds: 3_600,
      engineFreshnessSeconds: 3_600,
      allowedCapabilities: [],
      updatedAt: "2026-07-26T11:00:00.000Z",
      updatedBy: "principal-admin",
    },
    viewerCanEditPolicy: false,
  };
  assert.equal(
    mergeRunnerAdmissionPolicyResponse(current, older),
    current,
  );
  assert.equal(
    mergeRunnerAdmissionPolicyResponse(null, current),
    current,
  );
  assert.equal(
    mergeRunnerAdmissionPolicyResponse(
      current,
      { ...current, viewerCanEditPolicy: false },
    ).viewerCanEditPolicy,
    false,
  );
});

test("panel exposes independent loading and status semantics", () => {
  const html = renderToStaticMarkup(
    createElement(RunnerAdmissionPolicyPanel),
  );
  assert.match(html, /Consultando a decisão humana de admissão/u);
  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
});
