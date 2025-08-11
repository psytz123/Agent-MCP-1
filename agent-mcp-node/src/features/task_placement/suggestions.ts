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
  
  // Format status message with actionable guidance
  switch (status) {
    case 'approved':
      messages.push(`✅ Task placement approved: ${mainMessage}`);
      break;
    case 'suggest_changes':
      messages.push(`🔄 **ACTION REQUIRED**: Task placement needs adjustment`);
      messages.push(`**Issue**: ${mainMessage}`);
      messages.push(`**What you need to do**: Review and apply the suggestions below, then retry task creation.`);
      break;
    case 'warning':
      messages.push(`⚠️ **REVIEW RECOMMENDED**: Task placement warning`);
      messages.push(`**Issue**: ${mainMessage}`);
      messages.push(`**What you can do**: Consider the suggestions below or proceed with caution.`);
      break;
    case 'denied':
      messages.push(`❌ **TASK CREATION BLOCKED**: Cannot create task as specified`);
      messages.push(`**Issue**: ${mainMessage}`);
      messages.push(`**What you must do**: Address the issues below before creating this task.`);
      break;
  }
  
  const suggestions = validationResult.suggestions;
  
  // Format parent task suggestion with actionable steps
  const suggestedParent = suggestions.parent_task;
  if (suggestedParent !== originalParent && suggestedParent !== undefined) {
    messages.push(`\n📁 **PARENT TASK CORRECTION**:`);
    if (suggestedParent === null) {
      messages.push(`   • **Recommended**: Make this a root task (no parent)`);
      messages.push(`   • **Action**: Remove the parent_task_id parameter`);
    } else {
      messages.push(`   • **Recommended parent**: ${suggestedParent}`);
      messages.push(`   • **Action**: Set parent_task_id="${suggestedParent}"`);
    }
    if (originalParent) {
      messages.push(`   • **Original**: ${originalParent} (not optimal)`);
    }
  }
  
  // Format dependency suggestions with actionable steps
  const suggestedDeps = suggestions.dependencies || [];
  const originalDeps = originalDependencies || [];
  
  const addedDeps = suggestedDeps.filter(d => !originalDeps.includes(d));
  const removedDeps = originalDeps.filter(d => !suggestedDeps.includes(d));
  
  if (addedDeps.length > 0 || removedDeps.length > 0) {
    messages.push(`\n🔗 **DEPENDENCY CORRECTIONS**:`);
    
    if (addedDeps.length > 0) {
      messages.push(`   • **Add these dependencies**: ${addedDeps.join(', ')}`);
      messages.push(`   • **Action**: Include these task IDs in depends_on_tasks array`);
    }
    
    if (removedDeps.length > 0) {
      messages.push(`   • **Remove these dependencies**: ${removedDeps.join(', ')}`);
      messages.push(`   • **Action**: Remove these task IDs from depends_on_tasks array`);
    }
    
    if (suggestedDeps.length > 0) {
      messages.push(`   • **Final depends_on_tasks should be**: [${suggestedDeps.map(d => `"${d}"`).join(', ')}]`);
    } else {
      messages.push(`   • **Final depends_on_tasks should be**: [] (no dependencies)`);
    }
  }
  
  // Format reasoning if available
  if (suggestions.reasoning) {
    messages.push(`\n💡 **Why these changes are recommended**:`);
    messages.push(`   ${suggestions.reasoning}`);
  }
  
  // Format duplicates if any
  if (validationResult.duplicates.length > 0) {
    messages.push(`\n🔍 **SIMILAR TASKS DETECTED**:`);
    messages.push(`   **Action**: Review these existing tasks before creating a new one`);
    validationResult.duplicates.forEach(dup => {
      messages.push(`   • ${dup.task_id}: ${dup.title} (${Math.round(dup.similarity * 100)}% similar)`);
    });
    messages.push(`   **Consider**: Creating a subtask instead of a duplicate task`);
  }
  
  // Add clear retry instructions for non-approved tasks
  if (status !== 'approved') {
    messages.push(`\n📋 **HOW TO RETRY**:`);
    messages.push(`   1. Apply the corrections suggested above`);
    messages.push(`   2. Run the same command with updated parameters`);
    messages.push(`   3. Or use override_rag=true with override_reason if you disagree`);
    
    // Provide specific example if we have suggestions
    if (suggestedParent !== originalParent || addedDeps.length > 0 || removedDeps.length > 0) {
      messages.push(`\n💡 **CORRECTED COMMAND EXAMPLE**:`);
      let exampleParams = [];
      
      if (suggestedParent !== originalParent && suggestedParent !== undefined) {
        if (suggestedParent === null) {
          exampleParams.push('parent_task_id: null (or omit this parameter)');
        } else {
          exampleParams.push(`parent_task_id: "${suggestedParent}"`);
        }
      }
      
      if (suggestedDeps.length !== originalDeps.length || !suggestedDeps.every(d => originalDeps.includes(d))) {
        if (suggestedDeps.length === 0) {
          exampleParams.push('depends_on_tasks: []');
        } else {
          exampleParams.push(`depends_on_tasks: [${suggestedDeps.map(d => `"${d}"`).join(', ')}]`);
        }
      }
      
      if (exampleParams.length > 0) {
        messages.push(`   Use these corrected parameters:`);
        exampleParams.forEach(param => {
          messages.push(`   • ${param}`);
        });
      }
    }
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