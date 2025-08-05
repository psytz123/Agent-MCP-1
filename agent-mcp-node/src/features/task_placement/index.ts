// Task placement module exports
// Provides RAG-assisted task placement validation and suggestions

export { 
  validateTaskPlacement,
  type TaskPlacementValidationResult,
  type HierarchyAnalysis,
  type RAGValidationResponse 
} from './validator.js';

export { 
  formatSuggestionsForAgent,
  formatOverrideReason,
  shouldEscalateToAdmin 
} from './suggestions.js';

console.log('✅ Task placement module loaded');