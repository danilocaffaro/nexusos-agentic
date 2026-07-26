import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type { RealtimeSignal } from "@/src/contracts/realtime";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";

export interface RealtimeRecipientResolver {
  resolve(signal: RealtimeSignal): Promise<string[]>;
}

export class D1RealtimeRecipientResolver
  implements RealtimeRecipientResolver
{
  async resolve(signal: RealtimeSignal): Promise<string[]> {
    const d1 = getD1();
    if (signal.kind === "conversation") {
      const result = await d1
        .prepare(
          `SELECT member.principal_id
           FROM conversation_members member
           INNER JOIN memberships workspace_member
             ON workspace_member.organization_id = member.organization_id
            AND workspace_member.principal_id = member.principal_id
            AND workspace_member.status = 'active'
           INNER JOIN principals principal
             ON principal.organization_id = member.organization_id
            AND principal.id = member.principal_id
            AND principal.status = 'active'
            AND principal.kind = 'human'
           WHERE member.organization_id = ?
             AND member.conversation_id = ?
             AND member.status = 'active'
           ORDER BY member.principal_id`,
        )
        .bind(signal.organizationId, signal.conversationId)
        .all<{ principal_id: string }>();
      return result.results.map((row) => row.principal_id);
    }

    if (signal.kind === "attention") {
      const result = await d1
        .prepare(
          `SELECT principal.id AS principal_id
           FROM principals principal
           INNER JOIN memberships workspace_member
             ON workspace_member.organization_id = principal.organization_id
            AND workspace_member.principal_id = principal.id
            AND workspace_member.status = 'active'
           WHERE principal.organization_id = ?
             AND principal.id = ?
             AND principal.status = 'active'
             AND principal.kind = 'human'
           LIMIT 1`,
        )
        .bind(signal.organizationId, signal.principalId)
        .all<{ principal_id: string }>();
      return result.results.map((row) => row.principal_id);
    }

    const result = await d1
      .prepare(
        `SELECT principal.id AS principal_id
         FROM principals principal
         INNER JOIN memberships workspace_member
           ON workspace_member.organization_id = principal.organization_id
          AND workspace_member.principal_id = principal.id
          AND workspace_member.status = 'active'
         WHERE principal.organization_id = ?
           AND principal.status = 'active'
           AND principal.kind = 'human'
         ORDER BY principal.id`,
      )
      .bind(signal.organizationId)
      .all<{ principal_id: string }>();
    return result.results.map((row) => row.principal_id);
  }
}

export async function requireRealtimeSocketAccess(
  identity: RequestIdentity,
  conversationId: string | null,
): Promise<void> {
  await requireWorkspaceMember(identity);
  if (conversationId === null) return;

  const membership = await getD1()
    .prepare(
      `SELECT 1
       FROM conversation_members member
       INNER JOIN conversations conversation
         ON conversation.id = member.conversation_id
        AND conversation.organization_id = member.organization_id
       WHERE member.organization_id = ?
         AND member.conversation_id = ?
         AND member.principal_id = ?
         AND member.status = 'active'
       LIMIT 1`,
    )
    .bind(identity.organizationId, conversationId, identity.id)
    .first();
  if (!membership) {
    throw new WorkspaceRepositoryError("conversation_not_found", 404);
  }
}
