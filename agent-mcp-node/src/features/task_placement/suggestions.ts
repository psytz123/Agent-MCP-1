// Task placement suggestion parser and formatter
// Ported from Python suggestions.py

import { TaskPlacementValidationResult } from './validator.js';

/**
 * Format validation suggestions into human-readable text for agents.
 * 
 * @param validationResult Result from validateTaskPlacement
 * @param originalParent Originally proposed parent task
 * @param originalDependencies Originally proposed dependencies
 * @returns Formatted message for the agent
 */
export function formatSuggestionsForAgent(
  validationResult: TaskPlacementValidationResult,
  originalParent?: string | null,
  originalDependencies?: string[] | null
): string {
  const messages: string[] = [];
  
  // Add main status message
  const status = validationResult.status;
  const mainMessage = validationResult.message;
  
  // Check for hierarchy violations (can be inferred from status and message)
  const hierarchyViolation = mainMessage.toLowerCase().includes('hierarchy violation') || 
                            mainMessage.toLowerCase().includes('only one root task');
  
  if (hierarchyViolation) {
    messages.push('🚫 HIERARCHY VIOLATION: Only ONE root task is allowed!');
    messages.push('   This task MUST have a parent.');
  }
  
  // Format status message
  switch (status) {
    case 'approved':
      messages.push(`✓ Task placement approved: ${mainMessage}`);
      break;
    case 'suggest_changes':
      messages.push(`⚠️ Task placement suggestions: ${mainMessage}`);
      break;
    case 'warning':
      messages.push(`⚠️ Task placement warning: ${mainMessage}`);
      break;
    case 'denied':
      messages.push(`❌ Task placement denied: ${mainMessage}`);
      break;
  }
  
  const suggestions = validationResult.suggestions;
  
  // Format parent task suggestion
  const suggestedParent = suggestions.parent_task;
  if (suggestedParent !== originalParent && suggestedParent !== undefined) {
    messages.push(`\n📁 Suggested parent task: ${suggestedParent || 'Root task (no parent)'}`);
    if (originalParent) {
      messages.push(`   (instead of: ${originalParent})`);
    }
  }
  
  // Format dependency suggestions
  const suggestedDeps = suggestions.dependencies || [];
  const originalDeps = originalDependencies || [];
  
  const addedDeps = suggestedDeps.filter(d => !originalDeps.includes(d));
  const removedDeps = originalDeps.filter(d => !suggestedDeps.includes(d));
  
  if (addedDeps.length > 0) {
    messages.push(`\n➕ Suggested additional dependencies: ${addedDeps.join(', ')}`);
  }
  
  if (removedDeps.length > 0) {
    messages.push(`\n➖ Suggested to remove dependencies: ${removedDeps.join(', ')}`);
  }
  
  // Format reasoning if available
  if (suggestions.reasoning) {
    messages.push(`\n💡 Reasoning: ${suggestions.reasoning}`);
  }
  
  // Format duplicates if any
  if (validationResult.duplicates.length > 0) {
    messages.push('\n🔍 Similar tasks found:');
    validationResult.duplicates.forEach(dup => {
      messages.push(`   • ${dup.task_id}: ${dup.title} (${Math.round(dup.similarity * 100)}% similar)`);
    });
  }
  
  return messages.join('\n');
}

/**
 * Format override reason for logging and audit trail.
 * 
 * @param validationResult The validation result that was overridden
 * @param overrideReason User-provided reason for override
 * @param agentId ID of agent performing override
 * @returns Formatted override reason
 */
export function formatOverrideReason(
  validationResult: TaskPlacementValidationResult,
  overrideReason: string,
  agentId: string
): string {
  return `RAG Override by ${agentId}: ${overrideReason}\n\nOriginal RAG Assessment: ${validationResult.status}\nOriginal Message: ${validationResult.message}`;
}

/**
 * Determine if a validation result should escalate to admin review.
 * 
 * @param validationResult The validation result to check
 * @param agentId ID of the requesting agent
 * @returns True if admin review is recommended
 */
export function shouldEscalateToAdmin(
  validationResult: TaskPlacementValidationResult,
  agentId: string
): boolean {
  // Escalate denied tasks
  if (validationResult.status === 'denied') {
    return true;
  }
  
  // Escalate if potential duplicates with high similarity
  const highSimilarityDuplicate = validationResult.duplicates.some(dup => dup.similarity > 0.8);
  if (highSimilarityDuplicate) {
    return true;
  }
  
  // Escalate hierarchy violations
  if (validationResult.message.toLowerCase().includes('hierarchy violation')) {
    return true;
  }
  
  // Don't escalate for admin users
  if (agentId === 'admin' || agentId.toLowerCase().startsWith('admin')) {
    return false;
  }
  
  return false;
}

console.log('✅ Task placement suggestions loaded');