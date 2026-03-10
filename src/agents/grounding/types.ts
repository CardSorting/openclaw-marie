export interface GroundingPassResult {
  pass: number;
  name: string;
  result: string;
  confidence: number;
}

export interface GroundedSpec {
  /**
   * The grounded intent as interpreted by the grounder.
   */
  intent: string;
  /**
   * Project-specific rules identified as relevant to the intent.
   */
  rules: string[];
  /**
   * Environmental markers or constraints identified during discovery.
   */
  environmentMarkers: string[];
  /**
   * Confidence score for the grounding (0-1).
   */
  confidence: number;
  /**
   * Any missing information that needs clarification.
   */
  missingInfo?: string[];
  /**
   * Detailed results from individual hardening passes.
   */
  passes?: GroundingPassResult[];
  /**
   * Metadata about the grounding process.
   */
  metadata: {
    model?: string;
    latencyMs?: number;
    latencyBreakdown?: {
      prompt: number;
      llm: number;
    };
    timestamp: number;
    drift?: boolean;
    similarity?: number;
    retryCount?: number;
    error?: string;
  };
}

export type GroundingContext = {
  workspaceDir: string;
  agentId: string;
  sessionKey?: string;
  /** Historical grounding intents and specifications for alignment. */
  history?: GroundedSpec[];
  messageChannel?: string;
};
