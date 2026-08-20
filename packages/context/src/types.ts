export const CONTENT_TYPES = [
  "SYSTEM",
  "USER_QUERY",
  "AGENT_REASONING",
  "TOOL_CALL",
  "TOOL_RESULT_SMALL",
  "TOOL_RESULT_LARGE",
  "SUB_ANSWER",
  "CITATION",
  "ERROR_TRACE",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const COMPRESSION_LEVELS = ["NONE", "WEAK", "MEDIUM", "STRONG"] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number];

export interface FragmentMetadata {
  sourceRunId?: string;
  turnIndex?: number;
  ageTurns?: number;
  scratchpadRef?: string;
  originalSizeBytes?: number;
  priority?: number;
  source?: string;
}

export interface Fragment {
  id: string;
  type: ContentType;
  text: string;
  originalTokens: number;
  currentTokens: number;
  compressionLevel: CompressionLevel;
  droppable: boolean;
  metadata: FragmentMetadata;
}

export interface FragmentSpec {
  id?: string;
  type?: ContentType;
  text: string;
  metadata?: FragmentMetadata;
}

export const DEFAULT_DROPPABLE_TYPES: readonly ContentType[] = [
  "AGENT_REASONING",
  "TOOL_CALL",
  "ERROR_TRACE",
  "TOOL_RESULT_LARGE",
] as const;
