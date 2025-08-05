// Task placement validator using RAG system
// Ported from Python validator.py

import { queryRagSystem } from '../rag/query.js';
import { getDbConnection } from '../../db/connection.js';
import { MCP_DEBUG, TASK_ANALYSIS_MODEL, TASK_ANALYSIS_MAX_TOKENS } from '../../core/config.js';

export interface TaskPlacementValidationResult {
  status: 'approved' | 'suggest_changes' | 'warning' | 'denied';
  suggestions: {
    parent_task?: string | null;
    dependencies?: string[];
    reasoning?: string;
  };
  duplicates: Array<{
    task_id: string;
    similarity: number;
    title: string;
  }>;
  message: string;
}

export interface HierarchyAnalysis {
  root_task_exists: boolean;
  current_root_task_id: string | null;
  proposed_is_root: boolean;
  hierarchy_violation: boolean;
}

export interface RAGValidationResponse {
  placement_assessment: 'appropriate' | 'needs_adjustment' | 'problematic';
  hierarchy_analysis: HierarchyAnalysis;
  parent_suggestion: {
    recommended_parent: string | null;
    reasoning: string;
  };
  dependency_suggestions: {
    add_dependencies: string[];
    remove_dependencies: string[];
    reasoning: string;
  };
  duplication_check: {
    similar_tasks: Array<{
      task_id: string;
      title: string;
      similarity: number;
      reasoning: string;
    }>;
    is_duplicate: boolean;
  };
  critical_thinking_summary: string;
  overall_recommendation: 'proceed' | 'modify' | 'reconsider' | 'deny';
  message: string;
}

/**
 * Validate task placement using RAG system.
 * 
 * @param title Proposed task title
 * @param description Proposed task description
 * @param parentTaskId Proposed parent task ID (if any)
 * @param dependsOnTasks List of proposed dependency task IDs
 * @param createdBy Agent ID creating the task
 * @param authToken Authentication token for RAG query
 * @returns Validation results with suggestions
 */
export async function validateTaskPlacement(
  title: string,
  description: string,
  parentTaskId?: string | null,
  dependsOnTasks?: string[] | null,
  createdBy?: string,
  authToken?: string
): Promise<TaskPlacementValidationResult> {
  try {
    if (MCP_DEBUG) {
      console.log(`🔍 RAG Task Placement Validation: "${title}" by ${createdBy}`);
    }

    // Check if trying to create a root task (no parent)
    const db = getDbConnection();
    let rootTaskCheck = '';
    
    if (!parentTaskId) {
      // Check if a root task already exists
      const rootCountQuery = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE parent_task IS NULL');
      const rootCount = (rootCountQuery.get() as any)?.count || 0;
      
      if (rootCount > 0) {
        rootTaskCheck = `
        CRITICAL: There are already ${rootCount} root task(s) in the system. 
        ONLY ONE root task is allowed. This task MUST have a parent.
        `;
      }
    }

    // Format the query for RAG with emphasis on critical thinking
    const query = `
        ${rootTaskCheck}
        
        CRITICAL THINKING REQUIRED: Analyze the proposed task placement with deep consideration of the ENTIRE task hierarchy:
        
        Title: ${title}
        Description: ${description}
        Proposed Parent Task: ${parentTaskId || 'None (ATTEMPTING TO CREATE ROOT TASK)'}
        Proposed Dependencies: ${JSON.stringify(dependsOnTasks || [])}
        Created By: ${createdBy || 'unknown'}
        
        YOU MUST CRITICALLY EVALUATE:
        
        1. HIERARCHY RULES:
           - There can be ONLY ONE root task (no parent) in the entire system
           - Every other task MUST have a parent
           - If proposing a root task, explain why this should be THE root task
        
        2. LOGICAL PLACEMENT:
           - Analyze ALL existing tasks to find the most logical parent
           - Consider the task's purpose, scope, and relationship to other tasks
           - Don't just accept the proposed parent - think if there's a better one
        
        3. DEPENDENCIES:
           - Identify ALL tasks this should depend on based on logical workflow
           - Consider both direct and indirect dependencies
           - Remove any redundant or incorrect dependencies
        
        4. DUPLICATION:
           - Check if similar tasks already exist
           - Consider if this should be a subtask of an existing task instead
        
        5. PROJECT STRUCTURE:
           - Ensure the task fits logically within the project's architecture
           - Consider the impact on the overall task hierarchy
        
        Please respond in the following JSON format:
        {
            "placement_assessment": "appropriate" | "needs_adjustment" | "problematic",
            "hierarchy_analysis": {
                "root_task_exists": true | false,
                "current_root_task_id": "task_id or null",
                "proposed_is_root": true | false,
                "hierarchy_violation": true | false
            },
            "parent_suggestion": {
                "recommended_parent": "task_id or null",
                "reasoning": "detailed explanation of why this parent is the most logical choice after analyzing all tasks"
            },
            "dependency_suggestions": {
                "add_dependencies": ["task_id1", "task_id2"],
                "remove_dependencies": ["task_id3"],
                "reasoning": "detailed explanation of the dependency logic"
            },
            "duplication_check": {
                "similar_tasks": [
                    {
                        "task_id": "existing_task_id",
                        "title": "existing task title",
                        "similarity": 0.85,
                        "reasoning": "why they are similar"
                    }
                ],
                "is_duplicate": true | false
            },
            "critical_thinking_summary": "Your detailed analysis of how this task fits into the overall project structure",
            "overall_recommendation": "proceed" | "modify" | "reconsider" | "deny",
            "message": "Human-readable explanation of the assessment"
        }
        `;

    // Query the RAG system
    const responseText = await queryRagSystem(query);

    if (MCP_DEBUG) {
      console.log(`📊 RAG Validation Response: ${responseText.substring(0, 200)}...`);
    }

    // Check for "no knowledge" case
    if (responseText.toLowerCase().includes('no relevant context found') || 
        responseText.toLowerCase().includes('no knowledge')) {
      
      if (MCP_DEBUG) {
        console.log('📝 No task knowledge found - recommending initial setup');
      }

      return {
        status: 'suggest_changes',
        suggestions: {
          parent_task: null, // Root level for initial task
          dependencies: [],
          reasoning: 'No existing task hierarchy found. This should be a root-level task to establish the project structure.'
        },
        duplicates: [],
        message: 'No existing task knowledge found. Recommend creating as root task and adding project context/MCD.'
      };
    }

    // Try to parse JSON from the response
    let ragData: RAGValidationResponse | null = null;
    try {
      // Look for JSON in the response (it might be wrapped in other text)
      const jsonStart = responseText.indexOf('{');
      const jsonEnd = responseText.lastIndexOf('}') + 1;
      
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const jsonStr = responseText.substring(jsonStart, jsonEnd);
        ragData = JSON.parse(jsonStr) as RAGValidationResponse;
      }
    } catch (error) {
      console.warn(`Could not parse JSON from RAG response: ${responseText.substring(0, 200)}...`);
      ragData = null;
    }

    // Process the RAG response into our format
    if (ragData) {
      // Check for hierarchy violations first
      const hierarchyAnalysis = ragData.hierarchy_analysis || {};
      const hierarchyViolation = hierarchyAnalysis.hierarchy_violation || false;

      // Map RAG recommendations to our status codes
      const statusMap: { [key: string]: 'approved' | 'suggest_changes' | 'warning' | 'denied' } = {
        'proceed': 'approved',
        'modify': 'suggest_changes',
        'reconsider': 'warning',
        'deny': 'denied'
      };

      const status = statusMap[ragData.overall_recommendation] || 'suggest_changes';

      // Build suggestions based on RAG response
      const suggestions: TaskPlacementValidationResult['suggestions'] = {
        reasoning: ragData.critical_thinking_summary || ragData.message
      };

      // Apply parent suggestion if different from proposed
      const recommendedParent = ragData.parent_suggestion?.recommended_parent;
      if (recommendedParent !== parentTaskId) {
        suggestions.parent_task = recommendedParent;
        suggestions.reasoning += `\n\nParent Suggestion: ${ragData.parent_suggestion?.reasoning}`;
      }

      // Apply dependency suggestions
      const depSuggestions = ragData.dependency_suggestions;
      if (depSuggestions && (depSuggestions.add_dependencies?.length > 0 || depSuggestions.remove_dependencies?.length > 0)) {
        // Start with original dependencies and apply changes
        const originalDeps = dependsOnTasks || [];
        const newDeps = [...originalDeps];
        
        // Remove suggested removals
        depSuggestions.remove_dependencies?.forEach(depId => {
          const index = newDeps.indexOf(depId);
          if (index > -1) newDeps.splice(index, 1);
        });
        
        // Add suggested additions (avoid duplicates)
        depSuggestions.add_dependencies?.forEach(depId => {
          if (!newDeps.includes(depId)) newDeps.push(depId);
        });
        
        suggestions.dependencies = newDeps;
        suggestions.reasoning += `\n\nDependency Changes: ${depSuggestions.reasoning}`;
      }

      // Format duplicates
      const duplicates = ragData.duplication_check?.similar_tasks?.map(task => ({
        task_id: task.task_id,
        similarity: task.similarity,
        title: task.title
      })) || [];

      if (MCP_DEBUG) {
        console.log(`✅ RAG Validation Complete: ${status} with ${Object.keys(suggestions).length} suggestions`);
      }

      return {
        status,
        suggestions,
        duplicates,
        message: ragData.message || `Task placement ${status}: ${ragData.critical_thinking_summary}`
      };
    }

    // Fallback if RAG parsing failed
    return {
      status: 'warning',
      suggestions: {
        reasoning: 'RAG validation completed but response format was unclear. Manual review recommended.'
      },
      duplicates: [],
      message: `RAG validation response unclear. Raw response: ${responseText.substring(0, 200)}...`
    };

  } catch (error) {
    console.error('Error in RAG task placement validation:', error);
    
    // Return a safe fallback
    return {
      status: 'warning',
      suggestions: {
        reasoning: 'RAG validation failed - proceeding with original placement but manual review recommended.'
      },
      duplicates: [],
      message: `RAG validation error: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

console.log('✅ Task placement validator loaded');