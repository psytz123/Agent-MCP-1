// MCP Resources for Agent-MCP Node.js
// Provides agent data as MCP resources for @ mentions

import { getDbConnection } from '../db/connection.js';
import { MCP_DEBUG } from '../core/config.js';
import { globalState } from '../core/globals.js';
import { generateAgentSessionName } from '../utils/tmux.js';

// Resource interfaces
export interface AgentResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface AgentResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Get all active agents as resources
 */
export async function getAgentResources(): Promise<AgentResource[]> {
  const db = getDbConnection();
  
  try {
    const stmt = db.prepare(`
      SELECT 
        a.agent_id, 
        a.status, 
        a.created_at, 
        a.current_task,
        t.status as task_status,
        t.title as task_title,
        (SELECT COUNT(*) FROM tasks WHERE assigned_to = a.agent_id AND status = 'completed') as completed_tasks,
        (SELECT COUNT(*) FROM tasks WHERE assigned_to = a.agent_id AND status = 'in_progress') as active_tasks,
        (SELECT COUNT(*) FROM tasks WHERE assigned_to = a.agent_id AND status = 'pending') as pending_tasks
      FROM agents a
      LEFT JOIN tasks t ON a.current_task = t.task_id
      WHERE a.status IN ('created', 'active')
      ORDER BY a.created_at DESC
    `);
    
    const agents = stmt.all();
    
    return agents.map((agent: any) => {
      let statusDescription = '';
      
      if (agent.current_task && agent.task_status === 'in_progress') {
        const totalTasks = agent.completed_tasks + agent.active_tasks + agent.pending_tasks;
        statusDescription = `🔄 working (${agent.completed_tasks + 1} of ${totalTasks})`;
      } else if (agent.completed_tasks > 0 && !agent.current_task) {
        statusDescription = `✅ completed (${agent.completed_tasks} tasks)`;
      } else if (agent.pending_tasks > 0) {
        statusDescription = `📋 pending (${agent.pending_tasks} tasks)`;
      } else if (agent.status === 'active') {
        statusDescription = '🟢 active';
      } else {
        statusDescription = '🔵 ready';
      }
      
      return {
        uri: `agent://agent-mcp/${agent.agent_id}`,
        name: `@${agent.agent_id}`,
        description: statusDescription,
        mimeType: 'application/json'
      };
    });
  } catch (error) {
    console.error('Error fetching agent resources:', error);
    return [];
  }
}

/**
 * Get detailed agent information as resource content
 */
export async function getAgentResourceContent(agentId: string): Promise<AgentResourceContent | null> {
  const db = getDbConnection();
  
  try {
    // Get agent basic info
    const agentStmt = db.prepare(`
      SELECT a.*, t.title as current_task_title, t.description as current_task_description, t.status as current_task_status
      FROM agents a
      LEFT JOIN tasks t ON a.current_task = t.task_id
      WHERE a.agent_id = ?
    `);
    
    const agent = agentStmt.get(agentId) as any;
    
    if (!agent) {
      return null;
    }
    
    // Get all tasks for this agent
    const tasksStmt = db.prepare(`
      SELECT task_id, title, description, status, priority, created_at, updated_at
      FROM tasks 
      WHERE assigned_to = ? 
      ORDER BY 
        CASE status 
          WHEN 'in_progress' THEN 1
          WHEN 'pending' THEN 2  
          WHEN 'completed' THEN 3
          WHEN 'failed' THEN 4
          WHEN 'cancelled' THEN 5
        END,
        updated_at DESC
    `);
    
    const tasks = tasksStmt.all(agentId);
    
    // Get recent actions
    const actionsStmt = db.prepare(`
      SELECT action_type, timestamp, details
      FROM agent_actions 
      WHERE agent_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 5
    `);
    
    const recentActions = actionsStmt.all(agentId);
    
    const adminToken = getAdminToken();
    const tmuxSessionName = adminToken ? generateAgentSessionName(agent.agent_id, adminToken) : `${agent.agent_id}-0000`;
    
    const agentSummary = {
      "🤖 Agent": `@${agent.agent_id}`,
      "📊 Status": agent.status,
      "🎯 Capabilities": agent.capabilities ? JSON.parse(agent.capabilities) : [],
      "📁 Working Directory": agent.working_directory,
      "🕒 Created": new Date(agent.created_at).toLocaleString(),
      "─────────────────": "─────────────────",
      "🔧 TMUX SESSION": "─────────────────",
      "Session Name": tmuxSessionName,
      "Connect Command": `tmux attach-session -t ${tmuxSessionName}`,
      "View Logs": `tmux capture-pane -t ${tmuxSessionName} -p`,
      "─────────────────1": "─────────────────",
      "📋 CURRENT TASK": agent.current_task ? {
        "Task ID": agent.current_task,
        "Title": agent.current_task_title,
        "Status": agent.current_task_status,
        "Description": agent.current_task_description
      } : "No current task assigned",
      "─────────────────2": "─────────────────",
      "📝 ALL TASKS": tasks.length > 0 ? tasks.map((task: any) => ({
        "ID": task.task_id,
        "Title": task.title,
        "Status": `${getStatusEmoji(task.status)} ${task.status}`,
        "Priority": task.priority,
        "Updated": new Date(task.updated_at).toLocaleString()
      })) : "No tasks assigned",
      "─────────────────3": "─────────────────",
      "🕐 RECENT ACTIVITY": recentActions.length > 0 ? recentActions.map((action: any) => ({
        "Action": action.action_type,
        "Time": new Date(action.timestamp).toLocaleString(),
        "Details": action.details || "No details"
      })) : "No recent activity"
    };
    
    return {
      uri: `agent://agent-mcp/${agentId}`,
      mimeType: 'application/json',
      text: JSON.stringify(agentSummary, null, 2)
    };
  } catch (error) {
    console.error(`Error fetching agent resource content for ${agentId}:`, error);
    return null;
  }
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'in_progress': return '🔄';
    case 'completed': return '✅';
    case 'pending': return '📋';
    case 'failed': return '❌';
    case 'cancelled': return '🚫';
    default: return '❓';
  }
}

function getAdminToken(): string | null {
  if (globalState.adminToken) return globalState.adminToken;
  try {
    const row = getDbConnection().prepare("SELECT config_value FROM admin_config WHERE config_key = 'admin_token'").get() as any;
    return row?.config_value || null;
  } catch {
    return null;
  }
}

if (MCP_DEBUG) {
  console.log('✅ Agent resources module loaded');
}