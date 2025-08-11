// Agent management tools for Agent-MCP Node.js
// Ported from Python admin_tools.py

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { registerTool } from './registry.js';
import { getDbConnection } from '../db/connection.js';
import { getDatabaseStats } from '../db/schema.js';
import { VERSION, AGENT_COLORS, getProjectDir, MCP_DEBUG } from '../core/config.js';
import { verifyToken, getAgentId, generateToken as authGenerateToken, registerActiveAgent, unregisterActiveAgent } from '../core/auth.js';
import { globalState as coreGlobalState } from '../core/globals.js';
import { 
  isTmuxAvailable, 
  createTmuxSession, 
  sendCommandToSession, 
  generateAgentSessionName,
  sendPromptAsync,
  sendPromptToSession,
  killTmuxSession,
  sessionExists
} from '../utils/tmux.js';
import { buildAgentPrompt, TemplateType } from '../utils/promptTemplates.js';
import path from 'path';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Types for agent management
export interface Agent {
  token: string;
  agent_id: string;
  capabilities: string[];
  status: 'created' | 'active' | 'terminated' | 'failed' | 'completed';
  current_task?: string;
  working_directory: string;
  color: string;
  created_at: string;
  updated_at: string;
  terminated_at?: string;
}

// Use shared runtime state from coreGlobalState; do not shadow with a local state

// Helper functions
function generateAgentToken(): string {
  return randomUUID().replace(/-/g, '');
}

function getNextAgentColor(): string {
  const color = AGENT_COLORS[coreGlobalState.agentColorIndex % AGENT_COLORS.length] || 'blue';
  coreGlobalState.agentColorIndex++;
  return color;
}

function logAgentAction(agentId: string, action: string, details: any = {}) {
  const db = getDbConnection();
  const timestamp = new Date().toISOString();
  
  try {
    const stmt = db.prepare(`
      INSERT INTO agent_actions (agent_id, action_type, timestamp, details)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(agentId, action, timestamp, JSON.stringify(details));
    
    if (MCP_DEBUG) {
      console.log(`📝 Logged action: ${action} for agent ${agentId}`);
    }
  } catch (error) {
    console.error(`Failed to log agent action: ${error}`);
  }
}

// Create Agent Tool
registerTool(
  'create_agent',
  'Admin-only tool to create a new agent with specified capabilities and task assignments. Agents MUST have at least one task assigned. Workflow: 1) Create unassigned tasks first, 2) Create agent with those task IDs.',
  z.object({
    agent_id: z.string().describe('Unique identifier for the agent'),
    capabilities: z.array(z.string()).optional().describe('List of agent capabilities'),
    task_ids: z.array(z.string()).optional().describe('List of task IDs to assign to the agent (required - must have at least one task)'),
    admin_token: z.string().describe('Admin authentication token (required)')
  }),
  async (args, context) => {
    const { agent_id, capabilities = [], task_ids = [], admin_token } = args;
    
    // Verify admin authentication - REQUIRED
    if (!admin_token || !verifyToken(admin_token, 'admin')) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Unauthorized: Admin privileges required to create agents'
        }],
        isError: true
      };
    }
    
    // Basic validation
    if (!agent_id) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Error: agent_id is required. Please provide a unique identifier for the agent.'
        }],
        isError: true
      };
    }
    
    // Agents must have at least one task assigned
    if (!task_ids || task_ids.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Error: Agents must be created with at least one task assigned. Please provide task_ids.\n\n💡 **Workflow:**\n1. First create unassigned tasks using assign_task (without agent_token)\n2. Then create agent with those task IDs using create_agent'
        }],
        isError: true
      };
    }
    
    // Check if agent already exists (handled via database check below)
    
    const db = getDbConnection();
    
    try {
      // Check database for existing agent
      const existingAgent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(agent_id);
      if (existingAgent) {
        return {
          content: [{
            type: 'text' as const,
            text: `❌ Agent '${agent_id}' already exists in database`
          }],
          isError: true
        };
      }
      
      // Validate tasks if provided
      for (const taskId of task_ids) {
        const task = db.prepare('SELECT task_id, assigned_to, status FROM tasks WHERE task_id = ?').get(taskId);
        if (!task) {
          return {
            content: [{
              type: 'text' as const,
              text: `❌ Task '${taskId}' not found in database`
            }],
            isError: true
          };
        }
        
        if ((task as any).assigned_to) {
          return {
            content: [{
              type: 'text' as const,
              text: `❌ Task '${taskId}' is already assigned to agent '${(task as any).assigned_to}'`
            }],
            isError: true
          };
        }
      }
      
      // Generate agent data
      const newToken = generateAgentToken();
      const createdAt = new Date().toISOString();
      const agentColor = getNextAgentColor();
      const workingDir = getProjectDir();
      const status = 'created';
      
      // Begin transaction
      const transaction = db.transaction(() => {
        // Insert agent
        const insertAgent = db.prepare(`
          INSERT INTO agents (
            token, agent_id, capabilities, created_at, status, 
            working_directory, color, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        insertAgent.run(
          newToken,
          agent_id,
          JSON.stringify(capabilities),
          createdAt,
          status,
          workingDir,
          agentColor,
          createdAt
        );
        
        // Assign tasks
        const assignedTasks: string[] = [];
        for (const taskId of task_ids) {
          const updateTask = db.prepare(`
            UPDATE tasks 
            SET assigned_to = ?, status = 'pending', updated_at = ? 
            WHERE task_id = ?
          `);
          
          const result = updateTask.run(agent_id, createdAt, taskId);
          if (result.changes > 0) {
            assignedTasks.push(taskId);
          }
        }
        
        // Set current task to first assigned task
        if (assignedTasks.length > 0) {
          const updateCurrentTask = db.prepare(`
            UPDATE agents SET current_task = ? WHERE agent_id = ?
          `);
          updateCurrentTask.run(assignedTasks[0], agent_id);
        }
        
        // Log agent creation
        logAgentAction('admin', 'created_agent', {
          agent_id,
          color: agentColor,
          working_directory: workingDir,
          assigned_tasks: assignedTasks
        });
        
        return assignedTasks;
      });
      
      const assignedTasks = transaction();
      
      // Update global state
      const agentData: Agent = {
        token: newToken,
        agent_id,
        capabilities,
        status: 'created',
        current_task: assignedTasks[0] || undefined,
        working_directory: workingDir,
        color: agentColor,
        created_at: createdAt,
        updated_at: createdAt
      };

      // Register using token-keyed map for correctness
      registerActiveAgent(newToken, agentData);
      // Also keep fast lookup for working dirs by agent_id
      coreGlobalState.agentWorkingDirs.set(agent_id, workingDir);
      
      // Launch tmux session for the agent
      let launchStatus = '';
      if (await isTmuxAvailable()) {
        try {
          // Create sanitized session name
          const tmuxSessionName = generateAgentSessionName(agent_id, admin_token);

          // Prepare environment variables for the tmux session
          const serverPort = process.env.PORT || '3001';
          const serverUrl = process.env.MCP_SERVER_URL || `http://localhost:${serverPort}`;
          const envVars: Record<string, string> = {
            MCP_AGENT_ID: agent_id,
            MCP_AGENT_TOKEN: newToken,
            MCP_SERVER_URL: serverUrl,
            MCP_WORKING_DIR: workingDir,
          };

          // Create the tmux session (without immediate command, but with env)
          if (await createTmuxSession(tmuxSessionName, workingDir, undefined, envVars)) {
            // Track the tmux session in globals
            coreGlobalState.agentTmuxSessions.set(agent_id, tmuxSessionName);

            // Initial setup commands for visibility in tmux session
            const welcomeMessage = `echo '=== Agent ${agent_id} initialization starting ==='`;
            await sendCommandToSession(tmuxSessionName, welcomeMessage);
            await new Promise(resolve => setTimeout(resolve, 750));

            // Verify working directory
            await sendCommandToSession(tmuxSessionName, `echo 'Working directory:' && pwd`);
            await new Promise(resolve => setTimeout(resolve, 750));

            // Register MCP server connection (transport kept as configured externally)
            const mcpServerUrl = `${serverUrl}/mcp`;
            await sendCommandToSession(tmuxSessionName, `echo 'MCP Server URL: ${mcpServerUrl}'`);
            await new Promise(resolve => setTimeout(resolve, 750));

            const mcpAddCommand = `claude mcp add -t sse AgentMCP-Node ${mcpServerUrl}`;
            if (!await sendCommandToSession(tmuxSessionName, mcpAddCommand)) {
              launchStatus = `❌ Failed to register MCP server for agent '${agent_id}'.`;
            } else {
              await new Promise(resolve => setTimeout(resolve, 750));
              await sendCommandToSession(tmuxSessionName, 'claude mcp list');
              await new Promise(resolve => setTimeout(resolve, 750));

              // Start Claude
              await sendCommandToSession(tmuxSessionName, "echo '--- Starting Claude with MCP ---'");
              await new Promise(resolve => setTimeout(resolve, 750));
              if (!await sendCommandToSession(tmuxSessionName, 'claude --dangerously-skip-permissions')) {
                launchStatus = `❌ Failed to start Claude for agent '${agent_id}' after MCP registration.`;
              } else {
                launchStatus = `✅ tmux session '${tmuxSessionName}' created for agent '${agent_id}' with MCP registration and Claude.`;

                // Build and send high-quality system prompt (worker_with_rag)
                const prompt = buildAgentPrompt(
                  agent_id,
                  newToken,
                  admin_token,
                  'worker_with_rag'
                );

                if (prompt) {
                  setTimeout(async () => {
                    await sendPromptToSession(tmuxSessionName, prompt, 3);
                  }, 3000);
                }
              }
            }

            if (MCP_DEBUG) {
              console.log(`tmux session '${tmuxSessionName}' launched for agent '${agent_id}'`);
            }
          } else {
            launchStatus = `❌ Failed to create tmux session for agent '${agent_id}'.`;
          }
        } catch (error) {
          launchStatus = `❌ Failed to launch tmux session: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        console.warn('tmux is not available - agent session cannot be launched automatically');
        launchStatus = '⚠️ tmux not available - manual agent setup required.';
      }
      
      const response = [
        `✅ **Agent '${agent_id}' Created Successfully**`,
        '',
        `**Details:**`,
        `- Token: ${newToken}`,
        `- Color: ${agentColor}`,
        `- Working Directory: ${workingDir}`,
        `- Status: ${status}`,
        `- Capabilities: ${capabilities.join(', ') || 'None'}`,
        ''
      ];
      
      if (assignedTasks.length > 0) {
        response.push(`**Assigned Tasks:**`);
        assignedTasks.forEach(taskId => {
          response.push(`- ${taskId}`);
        });
        response.push(`**Current Task:** ${assignedTasks[0]}`);
        response.push('');
      } else {
        response.push(`**Tasks:** No tasks assigned`);
        response.push('');
      }
      
      // Add tmux launch status
      if (launchStatus) {
        response.push(`**Launch Status:**`);
        response.push(launchStatus);
        response.push('');
      }
      
      // Add tmux session info if available
      const sessionName = coreGlobalState.agentTmuxSessions.get(agent_id);
      if (sessionName) {
        response.push(`**Tmux Session:** ${sessionName}`);
        response.push(`**Connect Command:** \`tmux attach-session -t ${sessionName}\``);
        response.push('');
      }
      
      response.push('🤖 Agent is ready for activation');
      
      return {
        content: [{
          type: 'text' as const,
          text: response.join('\n')
        }]
      };
      
    } catch (error) {
      console.error(`Error creating agent ${agent_id}:`, error);
      return {
        content: [{
          type: 'text' as const,
          text: `❌ Error creating agent: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// View Status Tool
registerTool(
  'view_status',
  'View the status of all agents, connections, and the MCP server',
  z.object({
    admin_token: z.string().optional().describe('Admin authentication token (optional - uses session context)')
  }),
  async (args, context) => {
    // For MCP usage, default to admin access for system status
    // In production, this would check session context for proper authentication
    
    try {
      const db = getDbConnection();
      const stats = getDatabaseStats();
      
      // Get all agents from database
      const agents = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
      
      // Calculate uptime
      const startTime = new Date(coreGlobalState.serverStartTime);
      const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
      const uptimeHours = Math.floor(uptime / 3600);
      const uptimeMinutes = Math.floor((uptime % 3600) / 60);
      const uptimeSeconds = uptime % 60;
      
      const statusInfo = {
        server: {
          version: VERSION,
          uptime: `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`,
          startTime: coreGlobalState.serverStartTime
        },
        agents: {
          total: agents.length,
          active: agents.filter((a: any) => a.status === 'active').length,
          created: agents.filter((a: any) => a.status === 'created').length,
          terminated: agents.filter((a: any) => a.status === 'terminated').length
        },
        database: stats,
        memory: {
          activeAgents: coreGlobalState.activeAgents.size,
          workingDirs: coreGlobalState.agentWorkingDirs.size
        }
      };
      
      const response = [
        `🏥 **Agent-MCP System Status**`,
        '',
        `**Server Info:**`,
        `- Version: ${statusInfo.server.version}`,
        `- Uptime: ${statusInfo.server.uptime}`,
        `- Started: ${statusInfo.server.startTime}`,
        '',
        `**Agent Summary:**`,
        `- Total Agents: ${statusInfo.agents.total}`,
        `- Active: ${statusInfo.agents.active}`,
        `- Created: ${statusInfo.agents.created}`,
        `- Terminated: ${statusInfo.agents.terminated}`,
        '',
        `**Database Tables:**`
      ];
      
      Object.entries(statusInfo.database).forEach(([table, count]) => {
        response.push(`- ${table}: ${count >= 0 ? count : 'N/A'} records`);
      });
      
      if (agents.length > 0) {
        response.push('', '**Agent Details:**');
        agents.slice(0, 10).forEach((agent: any) => {
          response.push(`- **${agent.agent_id}** (${agent.status}) - ${agent.color}`);
          if (agent.current_task) {
            response.push(`  Current Task: ${agent.current_task}`);
          }
        });
        
        if (agents.length > 10) {
          response.push(`... and ${agents.length - 10} more agents`);
        }
      }
      
      response.push('', '✅ System operational');
      
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
          text: `❌ Error getting system status: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// Terminate Agent Tool
registerTool(
  'terminate_agent',
  'Admin-only tool to terminate an active agent with the given ID. Requires valid admin token.',
  z.object({
    agent_id: z.string().describe('Unique identifier for the agent to terminate'),
    admin_token: z.string().describe('Admin authentication token (required)')
  }),
  async (args, context) => {
    const { agent_id, admin_token } = args;
    
    // Verify admin authentication - REQUIRED
    if (!admin_token || !verifyToken(admin_token, 'admin')) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Unauthorized: Admin privileges required to terminate agents'
        }],
        isError: true
      };
    }
    
    if (!agent_id) {
      return {
        content: [{
          type: 'text' as const,
          text: '❌ Error: agent_id is required'
        }],
        isError: true
      };
    }
    
    const db = getDbConnection();
    
    try {
      // Check if agent exists
      const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ? AND status != ?').get(agent_id, 'terminated');
      
      if (!agent) {
        return {
          content: [{
            type: 'text' as const,
            text: `❌ Agent '${agent_id}' not found or already terminated`
          }],
          isError: true
        };
      }
      
      const terminatedAt = new Date().toISOString();
      
      // Begin transaction
      const transaction = db.transaction(() => {
        // Update agent status
        const updateAgent = db.prepare(`
          UPDATE agents 
          SET status = ?, terminated_at = ?, updated_at = ?, current_task = NULL
          WHERE agent_id = ? AND status != ?
        `);
        
        updateAgent.run('terminated', terminatedAt, terminatedAt, agent_id, 'terminated');
        
        // Unassign any assigned tasks
        const unassignTasks = db.prepare(`
          UPDATE tasks 
          SET assigned_to = NULL, status = 'pending', updated_at = ?
          WHERE assigned_to = ?
        `);
        
        const unassignResult = unassignTasks.run(terminatedAt, agent_id);
        
        // Log termination
        logAgentAction('admin', 'terminated_agent', {
          agent_id,
          tasks_unassigned: unassignResult.changes
        });
        
        return unassignResult.changes;
      });
      
      const tasksUnassigned = transaction();
      
      // Kill tmux session if it exists
      const tmuxSessionName = coreGlobalState.agentTmuxSessions.get(agent_id);
      let tmuxStatus = '';
      
      if (tmuxSessionName) {
        try {
          if (await sessionExists(tmuxSessionName)) {
            const killed = await killTmuxSession(tmuxSessionName);
            if (killed) {
              tmuxStatus = `- Tmux session '${tmuxSessionName}' killed`;
              if (MCP_DEBUG) {
                console.log(`✅ Killed tmux session for agent '${agent_id}': ${tmuxSessionName}`);
              }
            } else {
              tmuxStatus = `- ⚠️ Failed to kill tmux session '${tmuxSessionName}'`;
              console.warn(`Failed to kill tmux session for agent '${agent_id}': ${tmuxSessionName}`);
            }
          } else {
            tmuxStatus = `- Tmux session '${tmuxSessionName}' already stopped`;
          }
        } catch (error) {
          tmuxStatus = `- ⚠️ Error killing tmux session: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`Error killing tmux session for agent '${agent_id}':`, error);
        }
        
        // Remove from session tracking
        coreGlobalState.agentTmuxSessions.delete(agent_id);
      } else {
        tmuxStatus = '- No tmux session found';
      }
      
      // Update global state will be handled by unregisterActiveAgent using token below
      coreGlobalState.agentWorkingDirs.delete(agent_id);
      try {
        const agentRow = db.prepare('SELECT token FROM agents WHERE agent_id = ?').get(agent_id) as any;
        if (agentRow?.token) {
          unregisterActiveAgent(agentRow.token);
        }
      } catch {}
      
      const response = [
        `✅ **Agent '${agent_id}' Terminated Successfully**`,
        '',
        `- Terminated at: ${terminatedAt}`,
        `- Tasks unassigned: ${tasksUnassigned}`,
        tmuxStatus,
        '- Removed from active memory',
        '',
        '🔴 Agent is fully stopped'
      ];
      
      return {
        content: [{
          type: 'text' as const,
          text: response.join('\n')
        }]
      };
      
    } catch (error) {
      console.error(`Error terminating agent ${agent_id}:`, error);
      return {
        content: [{
          type: 'text' as const,
          text: `❌ Error terminating agent: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// List Agents Tool
registerTool(
  'list_agents',
  'List all agents with filtering options',
  z.object({
    status: z.enum(['created', 'active', 'terminated', 'failed', 'completed']).optional().describe('Filter by agent status'),
    limit: z.number().min(1).max(100).default(50).optional().describe('Maximum number of agents to return'),
    include_details: z.boolean().default(false).optional().describe('Include detailed agent information')
  }),
  async (args, context) => {
    const { status, limit = 50, include_details = false } = args;
    
    try {
      const db = getDbConnection();
      
      let query = 'SELECT * FROM agents';
      const params: any[] = [];
      
      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }
      
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      
      const agents = db.prepare(query).all(...params);
      
      if (agents.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No agents found${status ? ` with status '${status}'` : ''}`
          }]
        };
      }
      
      const response = [
        `🤖 **Agent List** (${agents.length} found)`,
        ''
      ];
      
      agents.forEach((agent: any) => {
        const caps = JSON.parse(agent.capabilities || '[]');
        response.push(`**${agent.agent_id}** - ${agent.status} ${agent.color}`);
        
        if (include_details) {
          response.push(`  Token: ${agent.token.substring(0, 8)}...`);
          response.push(`  Created: ${agent.created_at}`);
          response.push(`  Working Dir: ${agent.working_directory}`);
          if (agent.current_task) {
            response.push(`  Current Task: ${agent.current_task}`);
          }
          if (caps.length > 0) {
            response.push(`  Capabilities: ${caps.join(', ')}`);
          }
          if (agent.terminated_at) {
            response.push(`  Terminated: ${agent.terminated_at}`);
          }
        } else {
          if (agent.current_task) {
            response.push(`  Task: ${agent.current_task}`);
          }
          response.push(`  Created: ${new Date(agent.created_at).toLocaleDateString()}`);
        }
        
        response.push('');
      });
      
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
          text: `❌ Error listing agents: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

/**
 * Relaunch a terminated/completed/failed/cancelled agent in its existing tmux session
 */
registerTool(
  'relaunch_agent',
  'Relaunch an existing terminated/completed/failed/cancelled agent by reusing its tmux session. Sends /clear to reset and sends a new prompt.',
  z.object({
    admin_token: z.string().describe('Admin authentication token'),
    agent_id: z.string().describe('ID of the agent to relaunch'),
    generate_new_token: z.boolean().optional().default(false).describe('Generate a new token for the relaunched agent'),
    custom_prompt: z.string().optional().describe('Custom prompt to send instead of template prompt'),
    prompt_template: z.string().optional().default('worker_with_rag').describe('Prompt template to use')
  }),
  async (args, context) => {
    try {
      const { admin_token, agent_id, generate_new_token = false, custom_prompt, prompt_template = 'worker_with_rag' } = args;

      // Admin authentication
      if (!verifyToken(admin_token, 'admin')) {
        return {
          content: [{ type: 'text' as const, text: 'Unauthorized: Admin token required' }],
          isError: true
        };
      }

      if (!agent_id) {
        return {
          content: [{ type: 'text' as const, text: 'Error: agent_id is required' }],
          isError: true
        };
      }

      const db = getDbConnection();
      
      // Check if agent exists and get current status
      const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id) as any;
      if (!agent) {
        return {
          content: [{ type: 'text' as const, text: `Agent '${agent_id}' not found` }],
          isError: true
        };
      }

      const currentStatus = agent.status;
      
      // Only allow relaunch for certain statuses
      const allowedStatuses = ['terminated', 'completed', 'failed', 'cancelled'];
      if (!allowedStatuses.includes(currentStatus)) {
        return {
          content: [{ 
            type: 'text' as const, 
            text: `Cannot relaunch agent with status '${currentStatus}'. Allowed statuses: ${allowedStatuses.join(', ')}` 
          }],
          isError: true
        };
      }

      // Check if tmux session still exists
      const sessionName = coreGlobalState.agentTmuxSessions.get(agent_id);
      if (!sessionName) {
        return {
          content: [{ 
            type: 'text' as const, 
            text: `Agent '${agent_id}' has no active tmux session to relaunch. Use create_agent instead.` 
          }],
          isError: true
        };
      }

      if (!(await sessionExists(sessionName))) {
        // Clean up the dead session reference
        coreGlobalState.agentTmuxSessions.delete(agent_id);
        return {
          content: [{ 
            type: 'text' as const, 
            text: `Tmux session '${sessionName}' for agent '${agent_id}' no longer exists. Use create_agent instead.` 
          }],
          isError: true
        };
      }

      // Send /clear command to reset the session
      const clearSuccess = await sendCommandToSession(sessionName, '/clear');
      if (!clearSuccess) {
        return {
          content: [{ 
            type: 'text' as const, 
            text: `Failed to send /clear command to session '${sessionName}'` 
          }],
          isError: true
        };
      }

      // Generate new token if requested
      let agentToken = agent.token;
      if (generate_new_token) {
        agentToken = authGenerateToken();
        db.prepare('UPDATE agents SET token = ? WHERE agent_id = ?').run(agentToken, agent_id);
      }

      // Update agent status to active
      const updatedAt = new Date().toISOString();
      db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE agent_id = ?')
        .run('active', updatedAt, agent_id);

      // Build and send new prompt using the template system
      let promptToSend: string;
      if (custom_prompt) {
        promptToSend = buildAgentPrompt(
          agent_id,
          agentToken,
          admin_token,
          'custom',
          custom_prompt
        ) || `You are ${agent_id}.`;
      } else {
        promptToSend = buildAgentPrompt(
          agent_id,
          agentToken,
          admin_token,
          (prompt_template as TemplateType) || 'worker_with_rag'
        ) || `You are ${agent_id}.`;
      }

      // Send the new prompt to restart the agent with a delay
      setTimeout(async () => {
        try {
          await sendPromptToSession(sessionName, promptToSend);
        } catch (error) {
          console.error(`Failed to send restart prompt to ${agent_id}:`, error);
        }
      }, 2000);

      // Update in-memory state, keyed by token
      registerActiveAgent(agentToken, {
        token: agentToken,
        agent_id,
        status: 'active',
        capabilities: JSON.parse(agent.capabilities || '[]'),
        working_directory: agent.working_directory,
        color: agent.color,
        created_at: agent.created_at,
        updated_at: updatedAt,
        current_task: agent.current_task
      });

      // Log the action
      const actionDetails = {
        agent_id,
        session_name: sessionName,
        previous_status: currentStatus,
        new_token_generated: generate_new_token,
        prompt_template
      };

      db.prepare(`
        INSERT INTO agent_actions (agent_id, action_type, timestamp, details)
        VALUES (?, ?, ?, ?)
      `).run('admin', 'relaunch_agent', new Date().toISOString(), JSON.stringify(actionDetails));

      const responseParts = [
        `✅ **Agent '${agent_id}' successfully relaunched**`,
        ``,
        `**Session:** ${sessionName}`,
        `**Status:** ${currentStatus} → active`,
        `**Action:** Session cleared and new prompt sent`,
        ``
      ];

      if (generate_new_token) {
        responseParts.push(`**New Token:** ${agentToken}`);
      } else {
        responseParts.push(`**Token:** ${agentToken} (existing)`);
      }

      responseParts.push(``, `🚀 Agent is now active and should start working shortly`);

      return {
        content: [{ type: 'text' as const, text: responseParts.join('\n') }],
        isError: false
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error relaunching agent:', error);
      return {
        content: [{ type: 'text' as const, text: `❌ Error relaunching agent: ${errorMessage}` }],
        isError: true
      };
    }
  }
);

/**
 * Audit agent sessions and clean up inconsistencies
 */
registerTool(
  'audit_agent_sessions',
  'Intelligently audit agent tmux sessions. Analyzes activity patterns, task status, and recommends actions rather than auto-fixing.',
  z.object({
    admin_token: z.string().describe('Admin authentication token'),
    auto_cleanup_dead: z.boolean().optional().default(true).describe('Auto cleanup clearly dead sessions'),
    stale_threshold_minutes: z.number().optional().default(10).describe('Minutes of inactivity before considering stale'),
    kill_stale_sessions: z.boolean().optional().default(false).describe('Automatically kill stale sessions')
  }),
  async (args, context) => {
    try {
      const { admin_token, auto_cleanup_dead = true, stale_threshold_minutes = 10, kill_stale_sessions = false } = args;

      // Admin authentication
      if (!verifyToken(admin_token, 'admin')) {
        return {
          content: [{ type: 'text' as const, text: 'Unauthorized: Admin token required' }],
          isError: true
        };
      }

      const db = getDbConnection();
      const adminTokenSuffix = admin_token.slice(-4).toLowerCase();
      
      // Get all agents from database
      const agents = db.prepare('SELECT agent_id, status, token FROM agents').all() as any[];
      
      // Get all tmux sessions with the admin token suffix
      const { stdout: tmuxOutput } = await execAsync('tmux list-sessions -F "#{session_name}"');
      const allTmuxSessions = tmuxOutput.trim().split('\n').filter(line => line.length > 0);
      const agentSessions = allTmuxSessions.filter(session => session.includes(`-${adminTokenSuffix}`));
      
      const auditResults = [];
      const cleanupActions = [];

      // Check each agent in database
      for (const agent of agents) {
        const expectedSessionName = `${agent.agent_id}-${adminTokenSuffix}`;
        const hasActiveTmuxSession = agentSessions.includes(expectedSessionName);
        const isInMemory = coreGlobalState.agentTmuxSessions.has(agent.agent_id);
        const memorySessionName = coreGlobalState.agentTmuxSessions.get(agent.agent_id);

        const result = {
          agent_id: agent.agent_id,
          status: agent.status,
          expected_session: expectedSessionName,
          has_tmux_session: hasActiveTmuxSession,
          in_memory: isInMemory,
          memory_session: memorySessionName,
          consistency: 'OK'
        };

        // Check for inconsistencies
        if (agent.status === 'active' && !hasActiveTmuxSession) {
          result.consistency = 'INCONSISTENT: Active agent without tmux session';
          if (auto_cleanup_dead) {
            // Update agent status to terminated
            db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE agent_id = ?')
              .run('terminated', new Date().toISOString(), agent.agent_id);
            cleanupActions.push(`Set ${agent.agent_id} to terminated (no tmux session)`);
          }
        } else if ((agent.status === 'terminated' || agent.status === 'failed') && hasActiveTmuxSession) {
          result.consistency = 'INCONSISTENT: Terminated agent with live tmux session';
          if (auto_cleanup_dead) {
            // Add to memory so it can be relaunched
            coreGlobalState.agentTmuxSessions.set(agent.agent_id, expectedSessionName);
            cleanupActions.push(`Added ${agent.agent_id} to memory (found live tmux session)`);
          }
        } else if (isInMemory && !hasActiveTmuxSession) {
          result.consistency = 'INCONSISTENT: In memory but no tmux session';
          if (auto_cleanup_dead) {
            coreGlobalState.agentTmuxSessions.delete(agent.agent_id);
            cleanupActions.push(`Removed ${agent.agent_id} from memory (no tmux session)`);
          }
        } else if (!isInMemory && hasActiveTmuxSession && agent.status !== 'terminated') {
          result.consistency = 'INCONSISTENT: Has tmux session but not in memory';
          if (auto_cleanup_dead) {
            coreGlobalState.agentTmuxSessions.set(agent.agent_id, expectedSessionName);
            cleanupActions.push(`Added ${agent.agent_id} to memory (found tmux session)`);
          }
        }

        auditResults.push(result);
      }

      // Check for orphaned tmux sessions (sessions without corresponding agents)
      for (const sessionName of agentSessions) {
        const agentIdMatch = sessionName.match(/^(.+)-[a-f0-9]{4}$/);
        if (agentIdMatch) {
          const agentId = agentIdMatch[1];
          const agentExists = agents.some(a => a.agent_id === agentId);
          
          if (!agentExists) {
            auditResults.push({
              agent_id: agentId,
              status: 'ORPHANED',
              expected_session: sessionName,
              has_tmux_session: true,
              in_memory: false,
              memory_session: null,
              consistency: 'ORPHANED: Tmux session without database entry'
            });
            
            if (auto_cleanup_dead) {
              cleanupActions.push(`Found orphaned session: ${sessionName} (no database entry)`);
            }
          }
        }
      }

      // Build report
      const reportParts = [
        '🔍 **Agent Session Audit Report**',
        '',
        `**Summary:**`,
        `- Total agents in DB: ${agents.length}`,
        `- Active tmux sessions: ${agentSessions.length}`,
        `- Inconsistencies found: ${auditResults.filter(r => r.consistency !== 'OK').length}`,
        ''
      ];

      if (auto_cleanup_dead && cleanupActions.length > 0) {
        reportParts.push(
          '🧹 **Cleanup Actions Performed:**',
          ...cleanupActions.map(action => `- ${action}`),
          ''
        );
      }

      const inconsistentAgents = auditResults.filter(r => r.consistency !== 'OK');
      if (inconsistentAgents.length > 0) {
        reportParts.push(
          '⚠️ **Inconsistencies:**',
          ...inconsistentAgents.map(agent => 
            `- **${agent.agent_id}** (${agent.status}): ${agent.consistency}`
          ),
          ''
        );
      }

      reportParts.push(
        '✅ **Consistent Agents:**',
        ...auditResults.filter(r => r.consistency === 'OK').map(agent =>
          `- **${agent.agent_id}** (${agent.status}): Tmux=${agent.has_tmux_session}, Memory=${agent.in_memory}`
        )
      );

      return {
        content: [{ type: 'text' as const, text: reportParts.join('\n') }],
        isError: false
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error auditing agent sessions:', error);
      return {
        content: [{ type: 'text' as const, text: `❌ Error auditing sessions: ${errorMessage}` }],
        isError: true
      };
    }
  }
);

/**
 * Smart audit with activity analysis and intelligent recommendations
 */
registerTool(
  'smart_audit_agents',
  'Intelligently audit agents with activity analysis, task status checking, and smart recommendations for cleanup.',
  z.object({
    admin_token: z.string().describe('Admin authentication token'),
    stale_threshold_minutes: z.number().optional().default(10).describe('Minutes of inactivity before considering stale'),
    auto_kill_stale: z.boolean().optional().default(false).describe('Automatically kill sessions with no activity')
  }),
  async (args, context) => {
    try {
      const { admin_token, stale_threshold_minutes = 10, auto_kill_stale = false } = args;

      // Admin authentication
      if (!verifyToken(admin_token, 'admin')) {
        return {
          content: [{ type: 'text' as const, text: 'Unauthorized: Admin token required' }],
          isError: true
        };
      }

      const db = getDbConnection();
      const adminTokenSuffix = admin_token.slice(-4).toLowerCase();
      const staleThresholdMs = stale_threshold_minutes * 60 * 1000;
      const now = new Date();
      
      // Get all agents with extended info
      const agents = db.prepare(`
        SELECT a.agent_id, a.status, a.token, a.created_at, a.terminated_at, a.current_task,
               t.title as task_title, t.status as task_status
        FROM agents a 
        LEFT JOIN tasks t ON a.current_task = t.task_id
      `).all() as any[];
      
      // Get tmux sessions
      const { stdout: tmuxOutput } = await execAsync('tmux list-sessions -F "#{session_name}"');
      const allTmuxSessions = tmuxOutput.trim().split('\n').filter(line => line.length > 0);
      const agentSessions = allTmuxSessions.filter(session => session.includes(`-${adminTokenSuffix}`));
      
      // Get recent activity for all agents (last hour)
      const recentActivity = db.prepare(`
        SELECT agent_id, action_type, timestamp 
        FROM agent_actions 
        WHERE timestamp > datetime('now', '-1 hour')
        ORDER BY timestamp DESC
      `).all() as any[];
      
      const auditResults = [];
      const recommendations = [];
      const autoActions = [];

      // Analyze each agent
      for (const agent of agents) {
        const expectedSessionName = `${agent.agent_id}-${adminTokenSuffix}`;
        const hasActiveTmuxSession = agentSessions.includes(expectedSessionName);
        const isInMemory = coreGlobalState.agentTmuxSessions.has(agent.agent_id);
        
        // Get last activity for this agent
        const agentActivity = recentActivity.filter(a => a.agent_id === agent.agent_id);
        const lastActivity = agentActivity.length > 0 ? new Date(agentActivity[0].timestamp) : null;
        const minutesSinceActivity = lastActivity ? (now.getTime() - lastActivity.getTime()) / (1000 * 60) : Infinity;
        
        // Check if task is still relevant
        const taskRelevant = agent.task_status === 'in_progress' || agent.task_status === 'pending';
        
        const result = {
          agent_id: agent.agent_id,
          status: agent.status,
          task_status: agent.task_status || 'none',
          task_title: agent.task_title || 'none',
          has_tmux_session: hasActiveTmuxSession,
          in_memory: isInMemory,
          last_activity: lastActivity ? lastActivity.toISOString() : 'never',
          minutes_inactive: lastActivity ? Math.round(minutesSinceActivity) : 'never',
          is_stale: minutesSinceActivity > stale_threshold_minutes,
          recommendation: 'OK'
        };

        // Generate intelligent recommendations
        if (hasActiveTmuxSession && agent.status === 'terminated') {
          if (minutesSinceActivity > stale_threshold_minutes) {
            result.recommendation = 'KILL SESSION: Terminated agent with stale session';
            recommendations.push(`🗑️ Kill ${agent.agent_id} session (terminated ${Math.round(minutesSinceActivity)}min ago)`);
            
            if (auto_kill_stale) {
              try {
                await killTmuxSession(expectedSessionName);
                coreGlobalState.agentTmuxSessions.delete(agent.agent_id);
                autoActions.push(`Killed stale session: ${expectedSessionName}`);
              } catch (error) {
                autoActions.push(`Failed to kill session ${expectedSessionName}: ${error}`);
              }
            }
          } else if (taskRelevant) {
            result.recommendation = 'CONSIDER RELAUNCH: Recent termination with active task';
            recommendations.push(`🔄 Consider relaunching ${agent.agent_id} (task ${agent.task_status}, terminated recently)`);
          } else {
            result.recommendation = 'KILL SESSION: Terminated with completed/irrelevant task';
            recommendations.push(`🗑️ Kill ${agent.agent_id} session (task ${agent.task_status})`);
          }
        } else if (hasActiveTmuxSession && agent.status === 'created') {
          if (minutesSinceActivity > stale_threshold_minutes) {
            result.recommendation = 'KILL SESSION: Created but never activated';
            recommendations.push(`🗑️ Kill ${agent.agent_id} session (created but inactive ${Math.round(minutesSinceActivity)}min)`);
          } else {
            result.recommendation = 'MONITOR: Recently created, may be starting up';
            recommendations.push(`👀 Monitor ${agent.agent_id} (recently created)`);
          }
        } else if (hasActiveTmuxSession && agent.status === 'active') {
          if (minutesSinceActivity > stale_threshold_minutes) {
            result.recommendation = 'INVESTIGATE: Active agent but no recent activity';
            recommendations.push(`🔍 Check ${agent.agent_id} (active but silent ${Math.round(minutesSinceActivity)}min)`);
          } else {
            result.recommendation = 'HEALTHY: Active with recent activity';
          }
        } else if (!hasActiveTmuxSession && agent.status === 'active') {
          result.recommendation = 'UPDATE STATUS: Active agent without session';
          recommendations.push(`📝 Set ${agent.agent_id} status to terminated (no session)`);
        }

        // Auto-add to memory if session exists but not tracked
        if (hasActiveTmuxSession && !isInMemory && agent.status !== 'terminated') {
          coreGlobalState.agentTmuxSessions.set(agent.agent_id, expectedSessionName);
          autoActions.push(`Added ${agent.agent_id} to memory tracking`);
        }

        auditResults.push(result);
      }

      // Build smart report
      const totalSessions = agentSessions.length;
      const staleSessions = auditResults.filter(r => r.is_stale && r.has_tmux_session).length;
      const activeSessions = auditResults.filter(r => r.has_tmux_session && r.status === 'active').length;
      
      const reportParts = [
        '🧠 **Smart Agent Audit Report**',
        '',
        `**Activity Summary:**`,
        `- Total agents: ${agents.length}`,
        `- Live tmux sessions: ${totalSessions}`,
        `- Active agents: ${activeSessions}`,
        `- Stale sessions (>${stale_threshold_minutes}min): ${staleSessions}`,
        ''
      ];

      if (autoActions.length > 0) {
        reportParts.push(
          '⚡ **Auto Actions Performed:**',
          ...autoActions.map(action => `- ${action}`),
          ''
        );
      }

      if (recommendations.length > 0) {
        reportParts.push(
          '💡 **Recommendations:**',
          ...recommendations,
          ''
        );
      }

      // Show detailed status for agents with sessions
      const agentsWithSessions = auditResults.filter(r => r.has_tmux_session);
      if (agentsWithSessions.length > 0) {
        reportParts.push(
          '📊 **Agents with Sessions:**',
          ...agentsWithSessions.map(agent => 
            `- **${agent.agent_id}** (${agent.status}): Task=${agent.task_status}, Last=${agent.minutes_inactive === 'never' ? 'never' : agent.minutes_inactive + 'min ago'}, ${agent.recommendation}`
          ),
          ''
        );
      }

      return {
        content: [{ type: 'text' as const, text: reportParts.join('\n') }],
        isError: false
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error in smart agent audit:', error);
      return {
        content: [{ type: 'text' as const, text: `❌ Error in smart audit: ${errorMessage}` }],
        isError: true
      };
    }
  }
);

console.log('✅ Agent management tools registered successfully');