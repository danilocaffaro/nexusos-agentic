export type AttentionItem = {
  id: string;
  kind: "intent_awaiting_approval";
  status: "open" | "seen";
  version: number;
  createdAt: string;
  seenAt: string | null;
  intent: {
    id: string;
    actionType: string;
    targetRef: string;
    parametersHash: string;
    riskTier: "low" | "medium" | "high" | "critical";
    status: "proposed";
    expiresAt: string;
    projectId: string;
    projectName: string;
    proposerId: string;
    proposerName: string;
  };
};

export type AttentionPage = {
  items: AttentionItem[];
  total: number;
  openTotal: number;
  seenTotal: number;
  nextCursor: string | null;
};
