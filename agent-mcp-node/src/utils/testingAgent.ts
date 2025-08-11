/**
 * Testing Agent Auto-Launch System for Node.js
 * Automatically launches testing agents when tasks are completed
 */

import { getDbConnection } from '../db/connection.js';
import { buildAgentPrompt } from './promptTemplates.js';
import { MCP_DEBUG, getProjectDir } from '../core/config.js';
import { execSync } from 'child_process';
import * as crypto from 'crypto';

export interface TestingAgentLaunchResult {
  success: boolean;
  testing_agent_id: string;
  error?: string;
}

/**
 * Send escape sequences to pause an agent's tmux session
 */
export async function sendEscapeToAgent(agentId: string): Promise<boolean> {
  try {
    console.log(`🛑 Pausing agent ${agentId} with escape sequences`);
    
    // Get agent's tmux session from database
    const db = getDbConnection();
    const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as any;
    
    if (!agent) {
      console.warn(`⚠️ Agent ${agentId} not found in database`);
      return false;
    }
    
    // Calculate session name (agent-id with last 4 chars of admin token)
    const adminConfig = db.prepare('SELECT config_value FROM admin_config WHERE config_key = ?').get('admin_token') as any;
    const adminToken = adminConfig?.config_value;
    
    if (!adminToken) {
      console.error('❌ Admin token not found');
      return false;
    }
    
    const suffix = adminToken.slice(-4).toLowerCase();
    const sessionName = `${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${suffix}`;
    
    // Send 4 escape sequences with 1 second intervals
    for (let i = 0; i < 4; i++) {
      try {
        execSync(`tmux send-keys -t "${sessionName}" Escape`, { timeout: 5000 });
        console.log(`✅ Sent Escape ${i + 1}/4 to agent ${agentId}`);
        if (i < 3) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`❌ Failed to send Escape ${i + 1}/4 to agent ${agentId}:`, error);
        return false;
      }
    }
    
    console.log(`✅ Successfully paused agent ${agentId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error pausing agent ${agentId}:`, error);
    return false;
  }
}

/**
 * Generate a unique token for testing agent
 */
function generateTestingAgentToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate testing agent - wrapper function for compatibility with test scripts
 */
export async function generateTestingAgent(
  completedByAgent: string,
  completedTaskId: string
): Promise<TestingAgentLaunchResult> {
  return launchTestingAgentForCompletedTask(completedTaskId, completedByAgent);
}

function getAdminTokenFromDb(): string | null {
  try {
    const db = getDbConnection();
    const row = db.prepare("SELECT config_value FROM admin_config WHERE config_key = 'admin_token'").get() as any;
    return row?.config_value || null;
  } catch {
    return null;
  }
}

function makeTestingAgentId(completedTaskId: string): string {
  const suffix = completedTaskId.slice(-6) || crypto.randomUUID().slice(0, 6);
  return `test-${suffix}`;
}

/**
 * Launch testing agent for a completed task - matches Python implementation exactly
 */
export async function launchTestingAgentForCompletedTask(
  completedTaskId: string,
  completedByAgent: string
): Promise<TestingAgentLaunchResult> {
  
  const db = getDbConnection();
  
  try {
    console.log(`🧪 _launch_testing_agent_for_completed_task: ${completedTaskId} by ${completedByAgent}`);
    
    // Deterministic testing agent ID to match Python
    const testingAgentId = makeTestingAgentId(completedTaskId);
    
    // Clean up existing testing agent if present
    const existingAgent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(testingAgentId);
    if (existingAgent) {
      console.log(`🧹 Cleaning up existing testing agent ${testingAgentId}`);
      db.prepare('DELETE FROM agents WHERE agent_id = ?').run(testingAgentId);
      try {
        const adminToken = getAdminTokenFromDb();
        if (adminToken) {
          const suffix = adminToken.slice(-4).toLowerCase();
          const sessionName = `${testingAgentId}-${suffix}`;
          execSync(`tmux kill-session -t "${sessionName}"`, { timeout: 5000 });
          console.log(`🧹 Killed existing tmux session: ${sessionName}`);
        }
      } catch (error) {
        console.log(`ℹ️ No existing tmux session to kill for ${testingAgentId}`);
      }
    }
    
    // Create testing agent token and database entry
    const testingToken = crypto.randomBytes(16).toString('hex');
    const createdAt = new Date().toISOString();
    const projectDir = getProjectDir();
    
    const insertResult = db.prepare(`
      INSERT INTO agents (token, agent_id, capabilities, created_at, status, 
                        current_task, working_directory, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      testingToken,
      testingAgentId,
      JSON.stringify(['testing', 'validation', 'criticism']),
      createdAt,
      'created',
      completedTaskId,
      projectDir,
      '#FF0000'
    );
    
    if (insertResult.changes === 0) {
      return { success: false, testing_agent_id: testingAgentId, error: 'Failed to create agent in database' };
    }
    
    console.log(`✅ Testing agent ${testingAgentId} registered in database`);
    
    // Admin token and session naming
    const adminToken = getAdminTokenFromDb();
    if (!adminToken) {
      db.prepare('DELETE FROM agents WHERE agent_id = ?').run(testingAgentId);
      return { success: false, testing_agent_id: testingAgentId, error: 'Admin token not found' };
    }
    const suffix = adminToken.slice(-4).toLowerCase();
    const sessionName = `${testingAgentId}-${suffix}`;
    
    try {
      // Create tmux session with environment variables
      const serverPort = process.env.PORT || '3001';
      const serverUrl = process.env.MCP_SERVER_URL || `http://localhost:${serverPort}`;
      const envString = [
        `MCP_AGENT_ID="${testingAgentId}"`,
        `MCP_AGENT_TOKEN="${testingToken}"`,
        `MCP_SERVER_URL="${serverUrl}"`,
        `MCP_WORKING_DIR="${projectDir}"`
      ].join(' ');
      
      execSync(`cd "${projectDir}" && ${envString} tmux new-session -d -s "${sessionName}"`, { timeout: 10000 });
      console.log(`✅ Created tmux session: ${sessionName}`);
      
      // Register MCP server (leave transport string as-is per environment)
      execSync(`tmux send-keys -t "${sessionName}" "claude mcp add -t sse AgentMCP ${serverUrl}/mcp" Enter`, { timeout: 5000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Start Claude
      execSync(`tmux send-keys -t "${sessionName}" "claude --dangerously-skip-permissions" Enter`, { timeout: 5000 });
      console.log(`✅ Started Claude in session ${sessionName}`);
      
      // Build enriched prompt for testing agent
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(completedTaskId) as any;
      const prompt = buildAgentPrompt(
        testingAgentId,
        testingToken,
        adminToken,
        'testing_agent',
        undefined,
        {
          completed_by_agent: completedByAgent,
          completed_task_id: completedTaskId,
          completed_task_title: task?.title || 'Unknown',
          completed_task_description: task?.description || 'No description'
        }
      );
      if (!prompt) {
        db.prepare('DELETE FROM agents WHERE agent_id = ?').run(testingAgentId);
        return { success: false, testing_agent_id: testingAgentId, error: 'Failed to build prompt' };
      }
      
      // Send prompt after a short delay (escape quotes reliably)
      setTimeout(() => {
        try {
          const escaped = prompt.replace(/"/g, '\\"');
          execSync(`tmux send-keys -t "${sessionName}" "${escaped}"`, { timeout: 10000 });
          setTimeout(() => {
            try { execSync(`tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 }); } catch {}
          }, 500);
        } catch (error) {
          console.error(`❌ Failed to send prompt to session '${sessionName}':`, error);
        }
      }, 3000);
      
      // Log action
      db.prepare(`
        INSERT INTO agent_actions (agent_id, action_type, details, created_at, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        'admin',
        'create_testing_agent',
        JSON.stringify({ testing_agent_id: testingAgentId, completed_task_id: completedTaskId, completed_by_agent: completedByAgent, session_name: sessionName }),
        createdAt,
        createdAt
      );
      
      return { success: true, testing_agent_id: testingAgentId };
      
    } catch (error) {
      db.prepare('DELETE FROM agents WHERE agent_id = ?').run(testingAgentId);
      return { success: false, testing_agent_id: testingAgentId, error: `Failed to create tmux session: ${error}` };
    }
    
  } catch (error) {
    return { success: false, testing_agent_id: '', error: String(error) };
  }
}

/**
 * Send prompt to tmux session asynchronously (matches Python send_prompt_async)
 */
function sendPromptAsync(sessionName: string, prompt: string, delaySeconds: number = 3): void {
  setTimeout(() => {
    try {
      console.log(`⏳ Waiting ${delaySeconds} seconds for Claude to start up in session '${sessionName}'`);
      
      // Type the prompt text (without Enter) - matches Python tmux_utils.py:329-338  
      execSync(`tmux send-keys -t "${sessionName}" "${prompt.replace(/"/g, '\\"')}"`, { timeout: 10000 });
      console.log(`✅ Typed prompt to session '${sessionName}'`);
      
      // Small delay then send Enter - matches Python tmux_utils.py:340-355
      setTimeout(() => {
        try {
          execSync(`tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
          console.log(`✅ Successfully sent prompt to tmux session '${sessionName}'`);
        } catch (error) {
          console.error(`❌ Failed to send Enter to session '${sessionName}':`, error);
        }
      }, 500);
      
    } catch (error) {
      console.error(`❌ Failed to send prompt to session '${sessionName}':`, error);
    }
  }, delaySeconds * 1000);
}

/**
 * Auto-launch testing agents for multiple completed tasks
 */
export async function autoLaunchTestingAgents(
  completedTasks: Array<{ task_id: string; completed_by: string }>
): Promise<Array<{ task_id: string; testing_agent_launched: boolean; testing_agent_id?: string; error?: string }>> {
  
  const results = [];
  
  for (const { task_id, completed_by } of completedTasks) {
    try {
      const result = await launchTestingAgentForCompletedTask(task_id, completed_by);
      results.push({
        task_id,
        testing_agent_launched: result.success,
        testing_agent_id: result.testing_agent_id,
        error: result.error
      });
      
      if (MCP_DEBUG) {
        console.log(`🧪 Testing agent launch for task ${task_id}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      }
    } catch (error) {
      console.error(`❌ Failed to launch testing agent for task ${task_id}:`, error);
      results.push({
        task_id,
        testing_agent_launched: false,
        error: String(error)
      });
    }
  }
  
  return results;
}

/**
 * Send feedback message to the original agent after testing
 */
export async function sendTestingFeedbackToAgent(
  testingAgentId: string, 
  originalAgentId: string, 
  taskId: string, 
  testResults: { passed: boolean; issues: string[]; recommendations: string[] }
): Promise<boolean> {
  try {
    const db = getDbConnection();
    
    // Get testing agent token
    const testingAgent = db.prepare('SELECT token FROM agents WHERE agent_id = ?').get(testingAgentId);
    if (!testingAgent) {
      console.error(`❌ Testing agent ${testingAgentId} not found`);
      return false;
    }
    
    // Get original agent token
    const originalAgent = db.prepare('SELECT token FROM agents WHERE agent_id = ?').get(originalAgentId);
    if (!originalAgent) {
      console.error(`❌ Original agent ${originalAgentId} not found`);
      return false;
    }
    
    // Construct feedback message
    const statusEmoji = testResults.passed ? '✅' : '❌';
    const statusText = testResults.passed ? 'PASSED' : 'FAILED';
    
    let message = `🧪 **TESTING FEEDBACK for Task ${taskId}**\n\n`;
    message += `${statusEmoji} **Test Result: ${statusText}**\n\n`;
    
    if (testResults.issues.length > 0) {
      message += `**Issues Found:**\n`;
      testResults.issues.forEach((issue, i) => {
        message += `${i + 1}. ${issue}\n`;
      });
      message += '\n';
    }
    
    if (testResults.recommendations.length > 0) {
      message += `**Recommendations:**\n`;
      testResults.recommendations.forEach((rec, i) => {
        message += `${i + 1}. ${rec}\n`;
      });
      message += '\n';
    }
    
    message += `From: Testing Agent ${testingAgentId}\n`;
    message += `Task Status: ${testResults.passed ? 'Validated ✅' : 'Needs Revision ❌'}`;
    
    // Send message using the agent communication system
    const messageId = `test_feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const insertMessage = db.prepare(`
      INSERT INTO agent_messages (
        message_id, sender_id, recipient_id, message_content, 
        message_type, priority, timestamp, delivered, read
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertMessage.run(
      messageId,
      testingAgentId,
      originalAgentId,
      message,
      'assistance_request', // Use assistance_request type for testing feedback
      testResults.passed ? 'normal' : 'high', // High priority for failures
      new Date().toISOString(),
      0, // Not delivered yet
      0  // Not read yet
    );
    
    // Also send to tmux session if agent is active
    try {
      // Try to find agent's tmux session by pattern
      const stdout = execSync(`tmux list-sessions | grep "${originalAgentId}" | head -1 | cut -d: -f1`, { timeout: 5000 });
      const sessionName = stdout.toString().trim();
      
      if (sessionName) {
        const tmuxMessage = `🧪 Testing feedback received for task ${taskId}: ${statusText}`;
        execSync(`tmux display-message -t "${sessionName}" "${tmuxMessage}"`, { timeout: 5000 });
      }
    } catch (tmuxError) {
      // Non-critical - message is still in database
      console.log(`⚠️ Could not send tmux notification: ${tmuxError}`);
    }
    
    if (MCP_DEBUG) {
      console.log(`✅ Testing feedback sent from ${testingAgentId} to ${originalAgentId}`);
    }
    
    return true;
    
  } catch (error) {
    console.error(`❌ Error sending testing feedback:`, error);
    return false;
  }
}

/**
 * Clean incorrect or outdated project context based on testing results
 */
export async function cleanIncorrectProjectContext(
  testingAgentId: string,
  taskId: string,
  incorrectContextKeys: string[]
): Promise<{ cleaned: number; errors: string[] }> {
  try {
    const db = getDbConnection();
    const errors: string[] = [];
    let cleaned = 0;
    
    if (MCP_DEBUG) {
      console.log(`🧹 Testing agent ${testingAgentId} cleaning ${incorrectContextKeys.length} context entries`);
    }
    
    for (const contextKey of incorrectContextKeys) {
      try {
        // Check if context exists
        const existingContext = db.prepare('SELECT * FROM project_context WHERE context_key = ?').get(contextKey);
        
        if (existingContext) {
          // Archive the incorrect context with timestamp and reason
          const archiveKey = `archived_${contextKey}_${Date.now()}`;
          const context = existingContext as any;
          const archiveValue = {
            original_value: JSON.parse(context.value),
            archived_by: testingAgentId,
            archived_reason: `Identified as incorrect during task ${taskId} testing`,
            archived_at: new Date().toISOString(),
            original_updated_by: context.updated_by,
            original_updated_at: context.last_updated
          };
          
          // Insert archived version
          db.prepare(`
            INSERT OR REPLACE INTO project_context 
            (context_key, value, last_updated, updated_by, description)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            archiveKey,
            JSON.stringify(archiveValue),
            new Date().toISOString(),
            testingAgentId,
            `Archived incorrect context from ${contextKey}`
          );
          
          // Delete the incorrect context
          db.prepare('DELETE FROM project_context WHERE context_key = ?').run(contextKey);
          
          cleaned++;
          
          if (MCP_DEBUG) {
            console.log(`🧹 Cleaned context: ${contextKey} -> archived as ${archiveKey}`);
          }
          
        } else {
          errors.push(`Context key "${contextKey}" not found`);
        }
        
      } catch (contextError) {
        errors.push(`Failed to clean context "${contextKey}": ${contextError}`);
      }
    }
    
    // Log the context cleaning action
    const logAction = db.prepare(`
      INSERT INTO agent_actions (
        agent_id, action_type, task_id, timestamp, created_at, details
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const timestamp = new Date().toISOString();
    logAction.run(
      testingAgentId,
      'cleaned_project_context',
      taskId,
      timestamp,
      timestamp,
      JSON.stringify({
        cleaned_count: cleaned,
        error_count: errors.length,
        context_keys: incorrectContextKeys
      })
    );
    
    return { cleaned, errors };
    
  } catch (error) {
    console.error(`❌ Error cleaning project context:`, error);
    return { cleaned: 0, errors: [String(error)] };
  }
}

/**
 * Enhanced testing agent with feedback and context cleaning
 */
export async function runEnhancedTestingValidation(
  testingAgentId: string,
  originalAgentId: string,
  taskId: string,
  completedWork: any
): Promise<{ success: boolean; feedback_sent: boolean; context_cleaned: number }> {
  try {
    // Simulate testing validation (in real implementation, this would analyze the completed work)
    const testResults = {
      passed: Math.random() > 0.3, // 70% pass rate for demo
      issues: [
        'Implementation does not handle edge case X',
        'Code comments are insufficient for complex logic'
      ],
      recommendations: [
        'Add error handling for network timeouts',
        'Include unit tests for core functions',
        'Update documentation with usage examples'
      ]
    };
    
    // Send feedback to original agent
    const feedbackSent = await sendTestingFeedbackToAgent(
      testingAgentId, 
      originalAgentId, 
      taskId, 
      testResults
    );
    
    // Clean incorrect context if any issues found
    let contextCleaned = 0;
    if (!testResults.passed) {
      const incorrectContextKeys = [
        `task_${taskId}_assumptions`,
        `outdated_implementation_notes`
      ];
      
      const cleaningResult = await cleanIncorrectProjectContext(
        testingAgentId,
        taskId,
        incorrectContextKeys
      );
      
      contextCleaned = cleaningResult.cleaned;
    }
    
    if (MCP_DEBUG) {
      console.log(`🧪 Enhanced testing validation complete: feedback_sent=${feedbackSent}, context_cleaned=${contextCleaned}`);
    }
    
    return {
      success: true,
      feedback_sent: feedbackSent,
      context_cleaned: contextCleaned
    };
    
  } catch (error) {
    console.error(`❌ Enhanced testing validation failed:`, error);
    return {
      success: false,
      feedback_sent: false,
      context_cleaned: 0
    };
  }
}