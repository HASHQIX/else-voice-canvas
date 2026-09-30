/** ELSE v1 reference types, not an implemented application. */
export type Language = "ru" | "en";
export type Domain = "idea" | "audience" | "situation" | "value" | "trial" | "payment" | "acquisition" | "delivery" | "resources" | "assumption" | "next_step" | "other";
export interface Context {
  projectId: string; branchId: string; branchRevision: number;
  contextEpoch: number; turnGroupId: string; streamEpoch: number;
  transcriptRevision: number; semanticEpoch: number; sourceHash: string;
}
export interface SourceRef { turnId: string; quote: string }
export interface DraftItem {
  slot: "audience" | "value" | "situation" | "payment" | "acquisition" | "other";
  title: string; body: string; sourceQuote: string;
}
export interface Preview { ideaTitle: string; ideaSummary: string; draftItems: DraftItem[] }
export interface StatementProposal {
  ref: string; targetId: string | null;
  kind: "idea" | "statement" | "experiment" | "note";
  domain: Domain; title: string; body: string;
  disposition: "proposed" | "selected";
  sourceRefs: SourceRef[]; requestedLock: boolean | null;
}
export interface LinkProposal {
  sourceRef: string; targetRef: string;
  kind: "depends_on" | "supports" | "challenges" | "requires" | "tests";
  label: string;
}
export interface IssueProposal {
  ref: string; kind: "gap" | "tension"; title: string;
  relatedRefs: string[]; rationale: string; consequence: string;
  proposedChange: string; testSuggestion: string; sourceRefs: SourceRef[];
}
export interface BranchIntent {
  action: "create" | "switch_view" | "set_main";
  sourceBranchId: string | null; targetBranchId: string | null;
  forkNodeId: string | null; label: string; exploreNow: boolean;
}
export interface QuestionProposal {
  ref: string; targetRef: string | null; prompt: string; reason: string;
  options: Array<{ref: string; label: string; meaning: string}>;
}
export interface FinalPlan {
  language: Language;
  intent: "develop" | "challenge" | "clarify" | "answer" | "fork" | "navigate" | "defer" | "hold" | "finish" | "no_change";
  statements: StatementProposal[]; links: LinkProposal[];
  issues: IssueProposal[]; branchIntent: BranchIntent | null;
  question: QuestionProposal | null; assistantText: string; focusRef: string | null;
}
export interface NodeVersion {
  logicalId: string; versionId: string;
  kind: "idea" | "statement" | "question" | "option" | "issue" | "experiment" | "note";
  domain: Domain; title: string; body: string;
  origin: "user" | "agent" | "calculation";
  disposition: "proposed" | "selected" | "deferred" | "archived";
  evidence: "unverified" | "user_reported" | "deterministic" | "source_attached";
  freshness: "current" | "needs_review";
  locked: boolean; sourceRefs: SourceRef[];
  attributes: Record<string, unknown>;
}
export interface Snapshot {
  schemaVersion: 1; projectId: string; branchId: string; revision: number;
  nodes: Record<string, NodeVersion>;
  navigation: Array<{parentId: string; childId: string}>;
  dependencies: LinkProposal[];
  layout: Record<string, {x: number; y: number; width: number; height: number}>;
  pendingQuestionId: string | null;
}
export interface CommandEnvelope<T> {
  operationId: string; projectId: string; branchId: string;
  expectedRevision: number; contextEpoch: number; payload: T;
}
export interface WireMessage<T> {
  protocolVersion: 1; type: string; requestId: string;
  sessionId: string; contextEpoch: number; payload: T;
}
/** Browser-only draft/view data is never treated as committed evidence. */
export type CameraMode = "FOLLOW" | "MANUAL" | "OVERVIEW" | "COMPARE";
export interface ProviderResult<T> { context: Context; value: T; requestId: string }
