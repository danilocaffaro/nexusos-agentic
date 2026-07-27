import { getD1 } from "@/db";

const DECLARATION_NONCE_TTL_MS = 15 * 60 * 1_000;
const DECLARATION_RESPONSE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type SignedDeclarationResult = {
  status: number;
  body: string;
  replay: boolean;
};

export type DeclarationNonceInput = {
  runner: {
    id: string;
    organizationId: string;
  };
  nonce: string;
  signedRequestHash: string;
  now: string;
};

export type StoredDeclarationGuard = {
  kind: "capability" | "engine";
  reportId: string;
  operationRequestHash: string;
};

export async function findDeclarationNonceReplay(
  input: DeclarationNonceInput,
  errorFactory: (
    code: string,
    status: number,
  ) => DeclarationRepositoryError,
): Promise<SignedDeclarationResult | undefined> {
  const row = await getD1()
    .prepare(
      `SELECT nonce.request_hash, nonce.response_status, nonce.response_body
       FROM runner_capability_nonces nonce
       INNER JOIN runners runner
         ON runner.id = nonce.runner_id
        AND runner.organization_id = nonce.organization_id
       INNER JOIN principals principal
         ON principal.id = runner.principal_id
        AND principal.organization_id = runner.organization_id
       WHERE nonce.organization_id = ?
         AND nonce.runner_id = ? AND nonce.nonce = ?
         AND runner.status = 'active'
         AND principal.kind = 'runner' AND principal.status = 'active'
       LIMIT 1`,
    )
    .bind(
      input.runner.organizationId,
      input.runner.id,
      input.nonce,
    )
    .first<{
      request_hash: string;
      response_status: number;
      response_body: string;
    }>();
  if (!row) return undefined;
  if (row.request_hash !== input.signedRequestHash) {
    throw errorFactory("nonce_reused", 409);
  }
  return {
    status: row.response_status,
    body: row.response_body,
    replay: true,
  };
}

export function prepareDeclarationNonceInsert(
  d1: D1Database,
  input: DeclarationNonceInput,
  responseBody: string,
): D1PreparedStatement {
  const expiresAt = declarationNonceExpiresAt(input.now);
  return d1
    .prepare(
      `INSERT INTO runner_capability_nonces (
        organization_id, runner_id, nonce, request_hash, response_status,
        response_body, occurred_at, expires_at
      ) VALUES (?, ?, ?, ?, 201, ?, ?, ?)`,
    )
    .bind(
      input.runner.organizationId,
      input.runner.id,
      input.nonce,
      input.signedRequestHash,
      responseBody,
      input.now,
      expiresAt,
    );
}

export function prepareDeclarationReplayNonceInsert(
  d1: D1Database,
  input: DeclarationNonceInput,
  responseBody: string,
  guard: StoredDeclarationGuard,
): D1PreparedStatement {
  const expiresAt = declarationNonceExpiresAt(input.now);
  const statement =
    guard.kind === "capability"
      ? `INSERT INTO runner_capability_nonces (
          organization_id, runner_id, nonce, request_hash, response_status,
          response_body, occurred_at, expires_at
        )
        SELECT ?, ?, ?, ?, 201, ?, ?, ?
        FROM runner_capability_reports report
        WHERE report.organization_id = ?
          AND report.runner_id = ? AND report.report_id = ?
          AND report.request_hash = ?
          AND report.response_body = ? AND report.compacted_at IS NULL`
      : `INSERT INTO runner_capability_nonces (
          organization_id, runner_id, nonce, request_hash, response_status,
          response_body, occurred_at, expires_at
        )
        SELECT ?, ?, ?, ?, 201, ?, ?, ?
        FROM runner_engine_reports report
        WHERE report.organization_id = ?
          AND report.runner_id = ? AND report.report_id = ?
          AND report.request_hash = ?
          AND report.response_body = ? AND report.compacted_at IS NULL`;
  return d1
    .prepare(statement)
    .bind(
      input.runner.organizationId,
      input.runner.id,
      input.nonce,
      input.signedRequestHash,
      responseBody,
      input.now,
      expiresAt,
      input.runner.organizationId,
      input.runner.id,
      guard.reportId,
      guard.operationRequestHash,
      responseBody,
    );
}

export async function cleanupDeclarationOperationalState(
  organizationId: string,
  now: string,
): Promise<void> {
  const compactBefore = new Date(
    Date.parse(now) - DECLARATION_RESPONSE_TTL_MS,
  ).toISOString();
  const d1 = getD1();
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM runner_capability_nonces
         WHERE rowid IN (
           SELECT nonce.rowid
           FROM runner_capability_nonces nonce
           WHERE nonce.organization_id = ? AND nonce.expires_at <= ?
           ORDER BY nonce.expires_at, nonce.runner_id, nonce.nonce
           LIMIT 100
         )`,
      )
      .bind(organizationId, now),
    d1
      .prepare(
        `UPDATE runner_capability_reports
         SET response_body = NULL, compacted_at = ?
         WHERE rowid IN (
           SELECT report.rowid
           FROM runner_capability_reports report
           WHERE report.organization_id = ?
             AND report.compacted_at IS NULL
             AND report.received_at <= ?
           ORDER BY report.received_at, report.report_id
           LIMIT 100
         )`,
      )
      .bind(now, organizationId, compactBefore),
    d1
      .prepare(
        `UPDATE runner_engine_reports
         SET response_body = NULL, compacted_at = ?
         WHERE rowid IN (
           SELECT report.rowid
           FROM runner_engine_reports report
           WHERE report.organization_id = ?
             AND report.compacted_at IS NULL
             AND report.received_at <= ?
           ORDER BY report.received_at, report.report_id
           LIMIT 100
         )`,
      )
      .bind(now, organizationId, compactBefore),
  ]);
}

function declarationNonceExpiresAt(now: string): string {
  return new Date(Date.parse(now) + DECLARATION_NONCE_TTL_MS).toISOString();
}

export class DeclarationRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "DeclarationRepositoryError";
  }
}
