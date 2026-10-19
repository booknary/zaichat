export type MessageRole = "user" | "assistant" | "tool" | "system";
export type AgentRunStatus =
  | "running"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ZoteroObjectRef {
  libraryID: number;
  itemKey: string;
  itemType?: string;
  title?: string;
  invalid?: boolean;
}

export interface MessageContextRefs {
  items: ZoteroObjectRef[];
  attachments: ZoteroObjectRef[];
  notes: ZoteroObjectRef[];
  annotations: ZoteroObjectRef[];
  collections: Array<{
    libraryID: number;
    key: string;
    name?: string;
    invalid?: boolean;
  }>;
  hasEphemeralSelection?: boolean;
}

export interface EvidenceSnippet {
  sourceID: string;
  item: ZoteroObjectRef;
  attachment?: ZoteroObjectRef;
  text: string;
  field: "title" | "abstract" | "tag" | "author" | "note" | "annotation" | "fulltext";
  score: number;
  indexState?: string;
  position?: { start: number; end: number };
  matchedTerms?: string[];
  provenance?: PassageProvenance;
  coverage?: { cacheChars: number; scannedChars: number; truncated: boolean };
}

export interface PassageProvenance {
  section:
    | "methods"
    | "results"
    | "discussion"
    | "figure-legend"
    | "references"
    | "unknown";
  basis: "heading" | "bibliographic-pattern" | "text-pattern" | "unknown";
  confidence: "high" | "medium" | "low";
}

export type RetrievalProvenance =
  | "exact-title"
  | "metadata"
  | "abstract"
  | "tag"
  | "fulltext"
  | "semantic";

export interface SourceReference {
  sourceID: string;
  item: ZoteroObjectRef;
  attachment?: ZoteroObjectRef;
  label: string;
  snippet?: string;
  indexState?: string;
  coverage?: EvidenceSnippet["coverage"];
  position?: { start: number; end: number };
  field?: EvidenceSnippet["field"];
  provenance?: PassageProvenance;
}

export interface AgentEvent {
  id: string;
  type:
    | "tool-call"
    | "tool-result"
    | "approval"
    | "status"
    | "error"
    | "diagnostic"
    | "provider-reasoning";
  name?: string;
  status?: string;
  summary: string;
  createdAt: string;
  details?: Record<string, unknown>;
  reasoningContent?: string;
}

export type StoredProtocolMessage =
  | {
      role: "assistant";
      content: string;
      reasoningContent: string;
      toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      toolCallID: string;
      content: string;
    };

export interface StoredMessage {
  id: string;
  role: MessageRole;
  displayText: string;
  createdAt: string;
  contextRefs?: MessageContextRefs;
  sourceRefs?: SourceReference[];
  evidenceCoverage?: SourceReference[];
  agentEvents?: AgentEvent[];
  protocolHistory?: StoredProtocolMessage[];
  error?: boolean;
  relevantSourceIDs?: string[];
  irrelevantSourceIDs?: string[];
}

export interface AgentRun {
  id: string;
  conversationID: string;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
  toolCallCount: number;
  agentTurnCount?: number;
  events: AgentEvent[];
  pendingBatchID?: string;
  error?: string;
  terminationReason?: string;
}

export interface ChatConversation {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  lastRun?: AgentRun;
}

export interface ConversationIndexEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  unreadable?: boolean;
}

export interface ModelProfile {
  id: string;
  displayName: string;
  baseURL: string;
  apiKey: string;
  model: string;
  protocol: "auto" | "native-tools" | "json-actions";
  streaming: boolean;
  reasoningEnabled: boolean;
  reasoningEffort: "low" | "medium" | "high" | "max";
  timeoutMs: number;
  contextBudgetChars: number;
  evidenceBudgetChars: number;
}

export type SearchIntent =
  | "known_item"
  | "remembered_item"
  | "topic"
  | "method_use"
  | "claim_evidence"
  | "synthesis";

export type TerminologyRelation =
  | "canonical"
  | "exact_synonym"
  | "established_term"
  | "abbreviation"
  | "lexical_variant"
  | "rhetorical_paraphrase"
  | "broader_term"
  | "narrower_term"
  | "related_term";

export type TerminologyConfidence = "high" | "medium" | "low";
export type TerminologyOrigin = "model_inferred" | "candidate_observed";

export interface TerminologyVariant {
  term: string;
  relation: TerminologyRelation;
  confidence: TerminologyConfidence;
  origin?: TerminologyOrigin;
}

export interface RetrievalConcept {
  label: string;
  meaning: string;
  role: "required" | "optional";
  variants: TerminologyVariant[];
}

export interface RetrievalQuery {
  discipline?: string;
  subfield?: string;
  intent?: SearchIntent;
  concepts?: RetrievalConcept[];
  phrase?: string;
  exactTitles?: string[];
  titleHypotheses?: string[];
  englishQueries?: string[];
  searchCombinations?: string[];
  required: string[][];
  optional: string[][];
  excluded: string[];
  excludedTitles?: string[];
  authors?: string[];
  yearMin?: number;
  yearMax?: number;
  itemTypes?: string[];
  languages?: string[];
  collectionKeys?: string[];
  limit: number;
}

export interface RetrievalPlan extends RetrievalQuery {
  id: string;
  rationale: string;
  revisionReason?: string;
}

export interface SearchLearningEntry {
  query: string;
  successfulTitles: string[];
  rejectedTitles: string[];
  learnedTerms: string[];
  successfulCombinations: string[];
  updatedAt: string;
}

export interface RetrievedItem {
  publicationTitle?: string;
  doi?: string;
  date?: string;
  readWarnings?: string[];
  item: ZoteroObjectRef;
  title: string;
  abstract: string;
  authors: string[];
  tags: string[];
  year?: number;
  itemType?: string;
  language?: string;
  collections?: string[];
  notes?: string[];
  annotations?: string[];
  fulltext?: string[];
  fulltextMatchTerms?: string[];
  attachmentRefs?: ZoteroObjectRef[];
  provenance?: RetrievalProvenance[];
  score: number;
  matchedFields: EvidenceSnippet["field"][];
}

export interface RetrievalCandidate {
  publicationTitle?: string;
  doi?: string;
  date?: string;
  readWarnings?: string[];
  sourceID?: string;
  item: ZoteroObjectRef;
  title: string;
  authors: string[];
  year?: number;
  itemType?: string;
  language?: string;
  tags: string[];
  abstractExcerpt?: string;
  fulltextMatchTerms?: string[];
  attachmentRefs: ZoteroObjectRef[];
  provenance?: RetrievalProvenance[];
  score: number;
  matchedFields: EvidenceSnippet["field"][];
  indexState?: string;
}

export type WriteProposal =
  | {
      id: string;
      kind: "create-note";
      target: ZoteroObjectRef;
      html: string;
      label: string;
    }
  | {
      id: string;
      kind: "add-tags";
      target: ZoteroObjectRef;
      tags: string[];
      label: string;
    }
  | {
      id: string;
      kind: "relate-items";
      source: ZoteroObjectRef;
      targets: ZoteroObjectRef[];
      label: string;
    };

export interface PendingWriteBatch {
  id: string;
  conversationID: string;
  createdAt: string;
  proposals: WriteProposal[];
  status: "pending" | "approved" | "rejected" | "expired" | "executed";
}

export interface WriteOperationRecord {
  id: string;
  batchID: string;
  executedAt: string;
  status: "executed" | "undone" | "conflict";
  changes: Array<{
    kind: WriteProposal["kind"];
    target: ZoteroObjectRef;
    beforeVersion?: number;
    afterVersion?: number;
    created?: ZoteroObjectRef[];
    addedTags?: string[];
    related?: ZoteroObjectRef[];
  }>;
}

export interface ContextEnvelope {
  refs: MessageContextRefs;
  ephemeralSelection?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  retrievalRouteTrace?: Array<{
    routeIndex: number;
    hits: Array<{ libraryID: number; itemKey: string; rank: number; score: number }>;
  }>;
  retrievalTrace?: Array<{
    libraryID: number;
    itemKey: string;
    semanticRank?: number;
    lexicalRank?: number;
    fusedRank?: number;
    delivered?: boolean;
    stage: string;
    readWarnings?: string[];
  }>;
  toolCallID: string;
  name: string;
  ok: boolean;
  content: unknown;
  summary: string;
  sources?: SourceReference[];
  pendingBatch?: PendingWriteBatch;
  resultCount?: number;
  evidenceCharsUsed?: number;
  truncated?: boolean;
  planID?: string;
}

export interface EvidenceBudgetState {
  remainingChars: number;
  candidateRemainingChars?: number;
  verificationReserveChars?: number;
}
