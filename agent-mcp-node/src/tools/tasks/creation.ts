// Task creation tools for Agent-MCP Node.js
// Ported from Python task_tools.py (assign_task and create_self_task functions)

import { z } from 'zod';
import { registerTool } from '../registry.js';
import { getDbConnection } from '../../db/connection.js';
import { MCP_DEBUG, ENABLE_TASK_PLACEMENT_RAG, ALLOW_RAG_OVERRIDE } from '../../core/config.js';
import { verifyToken, getAgentId, validateAgentToken } from '../../core/auth.js';
import { globalState } from '../../core/globals.js';
import { 
  generateTaskId, 
  logTaskAction, 
  validateTaskStatus, 
  validateTaskPriority,
  analyzeAgentWorkload 
} from './core.js';
import { validateTaskPlacement, formatSuggestionsForAgent, shouldEscalateToAdmin } from '../../features/task_placement/index.js';
import { indexTaskData } from '../../features/rag/indexing.js';

// Create Self Task Tool (for agents to create subtasks)
registerTool(
  'create_self_task',
  'Create a subtask under current assignment. Agents can only create child tasks, never root tasks.',
  z.object({
    token: z.string().optional().describe('Agent authentication token (optional - uses session context)'),
    task_title: z.string().describe('Title of the task'),
    task_description: z.string().describe('Detailed description of the task'),
    priority: z.enum(['low', 'medium', 'high']).default('medium').describe('Task priority'),
    depends_on_tasks: z.array(z.string()).optional().describe('List of task IDs this task depends on'),
    parent_task_id: z.string().optional().describe('ID of the parent task (if not provided, uses current task)')
  }),
  async (args, context) => {
    const { token, task_title, task_description, priority, depends_on_tasks = [], parent_task_id } = args;
    
    // Get requesting agent ID from token or context
    let requestingAgentId: string | null = null;
    
    if (token) {
      requestingAgentId = getAgentId(token);
    } else {
      // For MCP connections, use session-based authentication
      // For now, default to 'admin' for testing - in production this would come from session context
      requestingAgentId = context.agentId || 'admin';
    }
    
    if (!requestingAgentId) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Unauthorized: Valid agent token required or session not authenticated'
        }],
        isError: true
      };
    }
    
    // Validate required fields
    if (!task_title || !task_description) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Error: task_title and task_description are required'
        }],
        isError: true
      };
    }
    
    const db = getDbConnection();
    
    try {
      // Determine parent task ID
      let actualParentTaskId = parent_task_id;
      
      if (!actualParentTaskId) {
        // Get agent's current task
        const agent = db.prepare('SELECT current_task FROM agents WHERE agent_id = ?').get(requestingAgentId);
        if (agent && (agent as any).current_task) {
          actualParentTaskId = (agent as any).current_task;
        }
      }
      
      // Agents can NEVER create root tasks
      if (requestingAgentId !== 'admin' && !actualParentTaskId) {
        // Find a suitable parent task suggestion
        const suggestedParent = db.prepare(`
          SELECT task_id, title FROM tasks 
          WHERE assigned_to = ? OR created_by = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(requestingAgentId, requestingAgentId);
        
        let suggestionText = '';
        if (suggestedParent) {
          suggestionText = `\nSuggested parent: ${(suggestedParent as any).task_id} (${(suggestedParent as any).title})`;
        }
        
        return {
          content: [{
            type: 'text' as const,
            text: `❌ ERROR: Agents cannot create root tasks. Every task must have a parent.${suggestionText}\nPlease specify a parent_task_id.`
          }],
          isError: true
        };
      }
      
      // Note: The old smart task placement logic has been replaced by RAG validation below
      // We no longer need to handle root task suggestions here as RAG validation handles it
      
      // Validate dependencies if provided
      for (const depTaskId of depends_on_tasks) {
        const depTask = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(depTaskId);
        if (!depTask) {
          return {
            content: [{
              type: 'text' as const,
              text: `❌ Error: Dependency task '${depTaskId}' not found`
            }],
            isError: true
          };
        }
      }
      
      // Generate task data
      const newTaskId = generateTaskId();
      const createdAt = new Date().toISOString();
      const status = 'pending';
      
      // RAG Pre-Check for Task Placement
      let finalParentTaskId = actualParentTaskId;
      let finalDependsOnTasks = depends_on_tasks;
      let validationMessage = '';
      
      if (ENABLE_TASK_PLACEMENT_RAG) {
        if (MCP_DEBUG) {
          console.log(`🧠 Running RAG validation for task: ${task_title}`);
        }
        
        try {
          const validationResult = await validateTaskPlacement(
            task_title,
            task_description,
            actualParentTaskId,
            depends_on_tasks,
            requestingAgentId,
            token
          );
          
          const suggestionMessage = formatSuggestionsForAgent(
            validationResult,
            actualParentTaskId,
            depends_on_tasks
          );
          
          // Check for denial
          if (validationResult.status === 'denied' && !ALLOW_RAG_OVERRIDE) {
            return {
              content: [{
                type: 'text' as const,
                text: `❌ Task creation BLOCKED by RAG validation:\n${suggestionMessage}`
              }],
              isError: true
            };
          }
          
          // Process validation results
          if (validationResult.status !== 'approved') {
            validationMessage = `\n🧠 RAG Validation (${validationResult.status}):\n${suggestionMessage}\n`;
            
            // For agents, automatically accept suggestions
            const suggestions = validationResult.suggestions;
            if (suggestions.parent_task !== undefined) {
              finalParentTaskId = suggestions.parent_task;
              validationMessage += `✓ Applied suggested parent: ${finalParentTaskId}\n`;
            }
            if (suggestions.dependencies) {
              finalDependsOnTasks = suggestions.dependencies;
              validationMessage += `✓ Applied suggested dependencies: ${finalDependsOnTasks.join(', ')}\n`;
            }
            
            if (MCP_DEBUG) {
              console.log(`📝 Agent ${requestingAgentId} automatically accepted RAG suggestions`);
            }
            
            // Check if escalation is needed
            if (shouldEscalateToAdmin(validationResult, requestingAgentId)) {
              console.warn(`Task ${newTaskId} flagged for admin review: ${validationResult.message}`);
              validationMessage += '⚠️ Task flagged for admin review\n';
            }
          } else {
            validationMessage = '\n✅ RAG validation approved placement\n';
          }
        } catch (error) {
          console.warn('RAG validation failed:', error);
          validationMessage = `\n⚠️ RAG validation failed: ${error instanceof Error ? error.message : String(error)}\n`;
        }
      }
      
      // Begin transaction
      const transaction = db.transaction(() => {
        // Insert new task
        const insertTask = db.prepare(`
          INSERT INTO tasks (
            task_id, title, description, assigned_to, created_by, status, priority,
            created_at, updated_at, parent_task, child_tasks, depends_on_tasks, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        insertTask.run(
          newTaskId,
          task_title,
          task_description,
          requestingAgentId, // Self-assigned
          requestingAgentId,
          status,
          priority,
          createdAt,
          createdAt,
          finalParentTaskId, // Use validated parent
          JSON.stringify([]), // Empty child tasks initially
          JSON.stringify(finalDependsOnTasks), // Use validated dependencies
          JSON.stringify([])   // Empty notes initially
        );
        
        // Update parent task's child_tasks if parent exists
        if (finalParentTaskId) {
          const parentTask = db.prepare('SELECT child_tasks FROM tasks WHERE task_id = ?').get(finalParentTaskId);
          if (parentTask) {
            const childTasks = JSON.parse((parentTask as any).child_tasks || '[]');
            childTasks.push(newTaskId);
            
            const updateParent = db.prepare('UPDATE tasks SET child_tasks = ?, updated_at = ? WHERE task_id = ?');
            updateParent.run(JSON.stringify(childTasks), createdAt, finalParentTaskId);
          }
        }
        
        // Log task creation
        logTaskAction(requestingAgentId, 'created_self_task', newTaskId, {
          title: task_title,
          priority,
          parent_task: finalParentTaskId,
          depends_on_count: finalDependsOnTasks.length
        });
        
        return newTaskId;
      });
      
      const taskId = transaction();
      
      // Index the new task for RAG
      try {
        const taskDataForIndexing = {
          task_id: taskId,
          title: task_title,
          description: task_description,
          assigned_to: requestingAgentId,
          created_by: requestingAgentId,
          status: status,
          priority: priority,
          created_at: createdAt,
          updated_at: createdAt,
          parent_task: finalParentTaskId,
          depends_on_tasks: finalDependsOnTasks,
          notes: []
        };
        
        // Start indexing asynchronously (fire and forget)
        indexTaskData(taskId, taskDataForIndexing).catch(error => {
          console.error(`Failed to index task ${taskId}:`, error);
        });
      } catch (error) {
        console.warn(`Task indexing setup failed for ${taskId}:`, error);
      }
      
      const response = [
        `✅ **Task '${taskId}' Created Successfully**`,
        '',
        `**Details:**`,
        `- Title: ${task_title}`,
        `- Priority: ${priority}`,
        `- Status: ${status}`,
        `- Assigned to: ${requestingAgentId} (self)`,
        `- Created by: ${requestingAgentId}`,
        ''
      ];
      
      if (finalParentTaskId) {
        response.push(`**Parent Task:** ${finalParentTaskId}`);
      }
      
      if (finalDependsOnTasks.length > 0) {
        response.push(`**Dependencies:** ${finalDependsOnTasks.join(', ')}`);
      }
      
      // Add RAG validation info
      if (validationMessage) {
        response.push(validationMessage);
      }
      
      response.push('', '🎯 Task is ready for work');
      
      if (MCP_DEBUG) {
        console.log(`📝 Agent ${requestingAgentId} created self-task: ${taskId}`);
      }
      
      return {
        content: [{
          type: 'text' as const,
          text: response.join('\n')
        }]
      };
      
    } catch (error) {
      console.error(`Error creating self-task for agent ${requestingAgentId}:`, error);
      return {
        content: [{
          type: 'text' as const,
          text: `❌ Error creating task: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Assign Task Tool (admin tool for creating and assigning tasks)
registerTool(
  'assign_task',
  'Admin tool to create and assign tasks to agents. Supports single task, multiple tasks, or assigning existing tasks.',
  z.object({
    token: z.string().describe('Admin authentication token'),
    agent_token: z.string().optional().describe('Agent token to assign task(s) to (if not provided, creates unassigned tasks)'),
    
    // Mode 1: Single task creation
    task_title: z.string().optional().describe('Title of the task (for single task creation)'),
    task_description: z.string().optional().describe('Description of the task (for single task creation)'),
    priority: z.enum(['low', 'medium', 'high']).default('medium').describe('Task priority (for single task)'),
    depends_on_tasks: z.array(z.string()).optional().describe('List of task IDs this task depends on'),
    parent_task_id: z.string().optional().describe('ID of the parent task'),
    
    // Mode 2: Multiple task creation
    tasks: z.array(z.object({
      title: z.string().describe('Task title'),
      description: z.string().describe('Task description'),
      priority: z.enum(['low', 'medium', 'high']).default('medium').describe('Task priority'),
      depends_on_tasks: z.array(z.string()).optional().describe('Dependencies for this task'),
      parent_task_id: z.string().optional().describe('Parent task for this task')
    })).optional().describe('Array of tasks to create and assign'),
    
    // Mode 3: Existing task assignment
    task_ids: z.array(z.string()).optional().describe('List of existing task IDs to assign to agent'),
    
    // Options
    validate_agent_workload: z.boolean().default(true).describe('Check agent capacity before assignment'),
    coordination_notes: z.string().optional().describe('Optional coordination context'),
    estimated_hours: z.number().optional().describe('Estimated hours for workload calculation')
  }),
  async (args, context) => {
    const { 
      token, 
      agent_token, 
      task_title, 
      task_description, 
      priority = 'medium',
      depends_on_tasks = [],
      parent_task_id,
      tasks,
      task_ids,
      validate_agent_workload = true,
      coordination_notes,
      estimated_hours
    } = args;
    
    // Verify admin authentication
    if (!verifyToken(token || '', 'admin')) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Unauthorized: Admin token required'
        }],
        isError: true
      };
    }
    
    // Handle unassigned task creation
    if (!agent_token) {
      return await createUnassignedTasks(args);
    }
    
    // Validate agent
    const targetAgentId = getAgentId(agent_token);
    if (!targetAgentId) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Error: Agent token not found. Agent may not exist or token is invalid.'
        }],
        isError: true
      };
    }
    
    // Prevent admin agents from being assigned tasks
    if (targetAgentId.toLowerCase().startsWith('admin')) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Error: Admin agents cannot be assigned tasks. Admin agents are for coordination and management only.'
        }],
        isError: true
      };
    }
    
    // Determine operation mode
    let operationMode: 'single' | 'multiple' | 'existing';
    
    if (task_ids && task_ids.length > 0) {
      operationMode = 'existing';
    } else if (tasks && tasks.length > 0) {
      operationMode = 'multiple';
    } else if (task_title && task_description) {
      operationMode = 'single';
    } else {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Error: Must provide either task_title & task_description (single), tasks array (multiple), or task_ids (existing assignment)'
        }],
        isError: true
      };
    }
    
    // Validate agent workload if requested
    if (validate_agent_workload) {
      const workload = analyzeAgentWorkload(targetAgentId);
      if (workload.workloadScore > 15) {
        return {
          content: [{
            type: 'text' as const,
            text: `⚠️ Warning: Agent ${targetAgentId} has high workload (score: ${workload.workloadScore}). Consider redistributing tasks or assign to different agent.\n\nWorkload Details:\n- Active tasks: ${(workload.tasksByStatus.pending || 0) + (workload.tasksByStatus.in_progress || 0)}\n- High priority tasks: ${workload.tasksByPriority.high || 0}\n\nRecommendations:\n${workload.recommendations.join('\n')}`
          }]
        };
      }
    }
    
    // Route to appropriate handler
    switch (operationMode) {
      case 'existing':
        return assignExistingTasks(targetAgentId, task_ids!, coordination_notes);
      case 'multiple':
        return createMultipleTasks(targetAgentId, tasks!, coordination_notes);
      case 'single':
        return await createSingleTask(targetAgentId, {
          title: task_title!,
          description: task_description!,
          priority,
          depends_on_tasks,
          parent_task_id
        }, coordination_notes);
    }
  }
);

// Helper functions for different assignment modes
async function createUnassignedTasks(args: any) {
  const { 
    task_title, 
    task_description, 
    priority = 'medium',
    depends_on_tasks = [],
    parent_task_id,
    tasks
  } = args;
  
  const db = getDbConnection();
  const results: string[] = [];
  const createdTasks: string[] = [];
  
  try {
    // Handle single task creation
    if (task_title && task_description) {
      const taskId = await createSingleUnassignedTask({
        title: task_title,
        description: task_description,
        priority,
        depends_on_tasks,
        parent_task_id
      });
      
      if (taskId) {
        createdTasks.push(taskId);
        results.push(`✅ Created unassigned task '${taskId}': ${task_title}`);
      } else {
        results.push(`❌ Failed to create task: ${task_title} (check server logs for details)`);
      }
    }
    
    // Handle multiple task creation
    if (tasks && Array.isArray(tasks)) {
      for (const task of tasks) {
        const taskId = await createSingleUnassignedTask({
          title: task.title,
          description: task.description,
          priority: task.priority || 'medium',
          depends_on_tasks: task.depends_on_tasks || [],
          parent_task_id: task.parent_task_id
        });
        
        if (taskId) {
          createdTasks.push(taskId);
          results.push(`✅ Created unassigned task '${taskId}': ${task.title}`);
        } else {
          results.push(`❌ Failed to create task: ${task.title} (check server logs for details)`);
        }
      }
    }
    
    const response = [
      `📝 **Unassigned Task Creation Results**`,
      '',
      ...results,
      '',
      `📊 **Summary:** ${createdTasks.length} task(s) created successfully`,
      '',
      '💡 **Next Steps:**',
      '1. Create agents using create_agent tool',
      '2. Assign tasks to agents using assign_task with task_ids parameter',
      '',
      `**Created Task IDs:** ${createdTasks.join(', ')}`
    ];
    
    return {
      content: [{
        type: 'text' as const,
        text: response.join('\n')
      }]
    };
    
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: `❌ Error creating unassigned tasks: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function createSingleUnassignedTask(taskData: {
  title: string;
  description: string;
  priority: string;
  depends_on_tasks: string[];
  parent_task_id?: string;
}): Promise<string | null> {
  const db = getDbConnection();
  
  try {
    // Validate dependencies if provided
    for (const depTaskId of taskData.depends_on_tasks) {
      const depTask = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(depTaskId);
      if (!depTask) {
        throw new Error(`Dependency task '${depTaskId}' not found`);
      }
    }
    
    // RAG Pre-Check for Task Placement
    let finalParentTaskId = taskData.parent_task_id;
    let finalDependsOnTasks = taskData.depends_on_tasks;
    
    if (ENABLE_TASK_PLACEMENT_RAG) {
      if (MCP_DEBUG) {
        console.log(`🧠 Running RAG validation for unassigned task: ${taskData.title}`);
      }
      
      try {
        const validationResult = await validateTaskPlacement(
          taskData.title,
          taskData.description,
          taskData.parent_task_id,
          taskData.depends_on_tasks,
          'admin',
          'admin_token'
        );
        
        const suggestionMessage = formatSuggestionsForAgent(
          validationResult,
          taskData.parent_task_id,
          taskData.depends_on_tasks
        );
        
        // Check for denial
        if (validationResult.status === 'denied' && !ALLOW_RAG_OVERRIDE) {
          throw new Error(`Task creation BLOCKED by RAG validation:\n${suggestionMessage}`);
        }
        
        // Apply suggestions automatically
        const suggestions = validationResult.suggestions;
        if (suggestions.parent_task !== undefined) {
          finalParentTaskId = suggestions.parent_task || undefined;
        }
        if (suggestions.dependencies) {
          finalDependsOnTasks = suggestions.dependencies;
        }
        
        if (MCP_DEBUG && validationResult.status !== 'approved') {
          console.log(`📝 RAG suggestions applied for unassigned task ${taskData.title}`);
        }
        
      } catch (error) {
        console.warn('RAG validation failed for unassigned task:', error);
        // For unassigned tasks, we can be more permissive
      }
    }
    
    // Generate task data
    const newTaskId = generateTaskId();
    const createdAt = new Date().toISOString();
    const status = 'unassigned';
    
    // Insert new task (unassigned - assigned_to is NULL)
    const insertTask = db.prepare(`
      INSERT INTO tasks (
        task_id, title, description, assigned_to, created_by, status, priority,
        created_at, updated_at, parent_task, child_tasks, depends_on_tasks, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertTask.run(
      newTaskId,
      taskData.title,
      taskData.description,
      null, // Unassigned
      'admin',
      status,
      taskData.priority,
      createdAt,
      createdAt,
      finalParentTaskId || null,
      JSON.stringify([]), // Empty child tasks initially
      JSON.stringify(finalDependsOnTasks),
      JSON.stringify([])   // Empty notes initially
    );
    
    // Update parent task's child_tasks if parent exists
    if (finalParentTaskId) {
      const parentTask = db.prepare('SELECT child_tasks FROM tasks WHERE task_id = ?').get(finalParentTaskId);
      if (parentTask) {
        const childTasks = JSON.parse((parentTask as any).child_tasks || '[]');
        childTasks.push(newTaskId);
        
        const updateParent = db.prepare('UPDATE tasks SET child_tasks = ?, updated_at = ? WHERE task_id = ?');
        updateParent.run(JSON.stringify(childTasks), createdAt, finalParentTaskId);
      }
    }
    
    // Log task creation
    logTaskAction('admin', 'created_unassigned_task', newTaskId, {
      title: taskData.title,
      priority: taskData.priority,
      parent_task: finalParentTaskId,
      depends_on_count: finalDependsOnTasks.length
    });
    
    // Index the new task for RAG
    try {
      const taskDataForIndexing = {
        task_id: newTaskId,
        title: taskData.title,
        description: taskData.description,
        assigned_to: null,
        created_by: 'admin',
        status: status,
        priority: taskData.priority,
        created_at: createdAt,
        updated_at: createdAt,
        parent_task: finalParentTaskId,
        depends_on_tasks: finalDependsOnTasks,
        notes: []
      };
      
      // Start indexing asynchronously (fire and forget)
      indexTaskData(newTaskId, taskDataForIndexing).catch(error => {
        console.error(`Failed to index unassigned task ${newTaskId}:`, error);
      });
    } catch (error) {
      console.warn(`Task indexing setup failed for unassigned task ${newTaskId}:`, error);
    }
    
    return newTaskId;
    
  } catch (error) {
    console.error(`Error creating unassigned task "${taskData.title}":`, error);
    // Log more details for debugging
    if (error instanceof Error) {
      console.error(`Task creation failed: ${error.message}`);
    }
    return null;
  }
}

function assignExistingTasks(agentId: string, taskIds: string[], notes?: string) {
  const db = getDbConnection();
  
  try {
    const results: string[] = [];
    const timestamp = new Date().toISOString();
    
    const transaction = db.transaction(() => {
      for (const taskId of taskIds) {
        // Check if task exists and is unassigned
        const task = db.prepare('SELECT task_id, title, assigned_to, status FROM tasks WHERE task_id = ?').get(taskId);
        
        if (!task) {
          results.push(`❌ Task '${taskId}' not found`);
          continue;
        }
        
        if ((task as any).assigned_to) {
          results.push(`⚠️ Task '${taskId}' already assigned to ${(task as any).assigned_to}`);
          continue;
        }
        
        // Assign task
        const updateTask = db.prepare('UPDATE tasks SET assigned_to = ?, status = ?, updated_at = ? WHERE task_id = ?');
        updateTask.run(agentId, 'pending', timestamp, taskId);
        
        results.push(`✅ Assigned '${taskId}': ${(task as any).title}`);
        
        // Log assignment
        logTaskAction(agentId, 'assigned_existing_task', taskId, { notes });
      }
    });
    
    transaction();
    
    return {
      content: [{
        type: 'text' as const,
        text: `**Task Assignment Results:**\n\n${results.join('\n')}\n\n📋 Assignment completed for agent: ${agentId}`
      }]
    };
    
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: `❌ Error assigning tasks: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

function createMultipleTasks(agentId: string, tasks: any[], notes?: string) {
  // Implementation for creating multiple tasks
  return {
    content: [{
      type: 'text' as const,
      text: '⚠️ Multiple task creation not yet implemented'
    }]
  };
}

async function createSingleTask(agentId: string, taskData: any, notes?: string) {
  const db = getDbConnection();
  
  try {
    const taskId = generateTaskId();
    const timestamp = new Date().toISOString();
    
    // RAG Pre-Check for Task Placement
    let finalParentTaskId = taskData.parent_task_id;
    let finalDependsOnTasks = taskData.depends_on_tasks || [];
    let validationMessage = '';
    
    if (ENABLE_TASK_PLACEMENT_RAG) {
      if (MCP_DEBUG) {
        console.log(`🧠 Running RAG validation for assigned task: ${taskData.title}`);
      }
      
      try {
        const validationResult = await validateTaskPlacement(
          taskData.title,
          taskData.description,
          taskData.parent_task_id,
          taskData.depends_on_tasks,
          'admin', // Created by admin
          'admin_token' // Admin context
        );
        
        const suggestionMessage = formatSuggestionsForAgent(
          validationResult,
          taskData.parent_task_id,
          taskData.depends_on_tasks
        );
        
        // Check for denial
        if (validationResult.status === 'denied' && !ALLOW_RAG_OVERRIDE) {
          return {
            content: [{
              type: 'text' as const,
              text: `❌ Task creation BLOCKED by RAG validation:\n${suggestionMessage}`
            }],
            isError: true
          };
        }
        
        // Process validation results
        if (validationResult.status !== 'approved') {
          validationMessage = `\n🧠 RAG Validation (${validationResult.status}):\n${suggestionMessage}\n`;
          
          // Apply suggestions automatically
          const suggestions = validationResult.suggestions;
          if (suggestions.parent_task !== undefined) {
            finalParentTaskId = suggestions.parent_task;
            validationMessage += `✓ Applied suggested parent: ${finalParentTaskId}\n`;
          }
          if (suggestions.dependencies) {
            finalDependsOnTasks = suggestions.dependencies;
            validationMessage += `✓ Applied suggested dependencies: ${finalDependsOnTasks.join(', ')}\n`;
          }
          
          if (MCP_DEBUG) {
            console.log(`📝 RAG suggestions automatically applied for task ${taskId}`);
          }
        } else {
          validationMessage = '\n✅ RAG validation approved placement\n';
        }
      } catch (error) {
        console.warn('RAG validation failed:', error);
        validationMessage = `\n⚠️ RAG validation failed: ${error instanceof Error ? error.message : String(error)}\n`;
      }
    }
    
    const transaction = db.transaction(() => {
      // Insert task
      const insertTask = db.prepare(`
        INSERT INTO tasks (
          task_id, title, description, assigned_to, created_by, status, priority,
          created_at, updated_at, parent_task, child_tasks, depends_on_tasks, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      const initialNotes = notes ? [{
        content: notes,
        timestamp,
        agent_id: 'admin'
      }] : [];
      
      insertTask.run(
        taskId,
        taskData.title,
        taskData.description,
        agentId,
        'admin',
        'pending',
        taskData.priority,
        timestamp,
        timestamp,
        finalParentTaskId || null,
        JSON.stringify([]),
        JSON.stringify(finalDependsOnTasks),
        JSON.stringify(initialNotes)
      );
      
      // Update parent if specified
      if (finalParentTaskId) {
        const parent = db.prepare('SELECT child_tasks FROM tasks WHERE task_id = ?').get(finalParentTaskId);
        if (parent) {
          const childTasks = JSON.parse((parent as any).child_tasks || '[]');
          childTasks.push(taskId);
          
          const updateParent = db.prepare('UPDATE tasks SET child_tasks = ?, updated_at = ? WHERE task_id = ?');
          updateParent.run(JSON.stringify(childTasks), timestamp, finalParentTaskId);
        }
      }
      
      // Log assignment
      logTaskAction(agentId, 'assigned_new_task', taskId, { 
        title: taskData.title, 
        priority: taskData.priority,
        notes 
      });
      
      return taskId;
    });
    
    const newTaskId = transaction();
    
    // Index the new task for RAG
    try {
      const taskDataForIndexing = {
        task_id: newTaskId,
        title: taskData.title,
        description: taskData.description,
        assigned_to: agentId,
        created_by: 'admin',
        status: 'pending',
        priority: taskData.priority,
        created_at: timestamp,
        updated_at: timestamp,
        parent_task: finalParentTaskId,
        depends_on_tasks: finalDependsOnTasks,
        notes: notes ? [{ content: notes, timestamp, agent_id: 'admin' }] : []
      };
      
      // Start indexing asynchronously (fire and forget)
      indexTaskData(newTaskId, taskDataForIndexing).catch(error => {
        console.error(`Failed to index task ${newTaskId}:`, error);
      });
    } catch (error) {
      console.warn(`Task indexing setup failed for ${newTaskId}:`, error);
    }
    
    let responseText = `✅ **Task '${newTaskId}' Created and Assigned**\n\n**Details:**\n- Title: ${taskData.title}\n- Priority: ${taskData.priority}\n- Assigned to: ${agentId}\n- Status: pending`;
    
    if (finalParentTaskId) {
      responseText += `\n- Parent Task: ${finalParentTaskId}`;
    }
    
    if (finalDependsOnTasks.length > 0) {
      responseText += `\n- Dependencies: ${finalDependsOnTasks.join(', ')}`;
    }
    
    // Add RAG validation info
    if (validationMessage) {
      responseText += validationMessage;
    }
    
    responseText += '\n\n🎯 Task is ready for work';
    
    return {
      content: [{
        type: 'text' as const,
        text: responseText
      }]
    };
    
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: `❌ Error creating task: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

// Note: Old helper functions (getAvailableParentTasks, isPhaseComplete, getSmartParentSuggestions, calculateSimilarity) 
// have been replaced with RAG-based task placement validation system

console.log('✅ Task creation tools registered successfully');