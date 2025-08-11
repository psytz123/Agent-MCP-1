// Claude Code session monitor for Agent-MCP Node.js
// Periodically scans tmux sessions and records activity in the database

import { promisify } from 'util';
import { exec } from 'child_process';
import { getDbConnection } from '../../db/connection.js';
import { MCP_DEBUG } from '../../core/config.js';
import { globalState } from '../../core/globals.js';
import { getAdminTokenSuffix, parseAgentSessionName } from '../../utils/tmux.js';

const execAsync = promisify(exec);

interface TmuxSessionInfo {
  name: string;
  attached: boolean;
  lastActivityEpoch?: number;
}

async function listSessions(): Promise<TmuxSessionInfo[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}|#{session_attached}|#{session_activity}"');
    const lines = stdout.trim().split('\n').filter(Boolean);
    const sessions: TmuxSessionInfo[] = [];
    for (const line of lines) {
      const [name, attachedStr, activityStr] = line.split('|');
      if (!name) continue;
      const attached = attachedStr === '1';
      const lastActivityEpoch = activityStr ? parseInt(activityStr, 10) : undefined;
      sessions.push({ name, attached, lastActivityEpoch });
    }
    return sessions;
  } catch (error) {
    if (MCP_DEBUG) console.error('Claude monitor: failed to list tmux sessions', error);
    return [];
  }
}

async function sessionHasClaudeProcess(sessionName: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`tmux list-panes -t "${sessionName}" -F "#{pane_current_command}|#{pane_title}"`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const lowered = line.toLowerCase();
      if (lowered.includes('claude')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function upsertSession(
  sessionId: string,
  agentId: string | null,
  status: string,
  lastActivityIso: string,
  metadata: Record<string, any>
): void {
  try {
    const db = getDbConnection();
    const nowIso = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO claude_code_sessions 
      (session_id, pid, parent_pid, first_detected, last_activity, working_directory, agent_id, status, metadata)
      VALUES (?, ?, ?, COALESCE((SELECT first_detected FROM claude_code_sessions WHERE session_id = ?), ?), ?, ?, ?, ?, ?)
    `);
    stmt.run(
      sessionId,
      process.pid,
      process.ppid || 0,
      sessionId,
      nowIso,
      lastActivityIso,
      process.cwd(),
      agentId || null,
      status,
      JSON.stringify(metadata)
    );
  } catch (error) {
    console.error('Claude monitor: DB upsert failed', error);
  }
}

async function scanOnce(adminToken?: string): Promise<void> {
  const sessions = await listSessions();
  for (const s of sessions) {
    const hasClaude = await sessionHasClaudeProcess(s.name);
    const lastActivityIso = s.lastActivityEpoch ? new Date(s.lastActivityEpoch * 1000).toISOString() : new Date().toISOString();
    let agentId: string | null = null;

    if (adminToken) {
      const inferred = parseAgentSessionName(s.name, adminToken);
      if (inferred) agentId = inferred;
    }

    const status = s.attached ? 'active' : (hasClaude ? 'registered' : 'detected');
    upsertSession(
      s.name,
      agentId,
      status,
      lastActivityIso,
      {
        hasClaude,
        attached: s.attached,
        detected_via: 'tmux_scan'
      }
    );

    if (MCP_DEBUG) {
      console.log(`🕵️  Claude monitor: ${s.name} -> status=${status}, agent=${agentId || 'n/a'}, hasClaude=${hasClaude}`);
    }
  }
}

export function startClaudeSessionMonitor(adminToken?: string, intervalSeconds: number = 5): void {
  if (globalState.claudeSessionTaskHandle) {
    console.log('⚠️ Claude session monitor already running');
    return;
  }
  console.log(`👁️  Starting Claude session monitor (every ${intervalSeconds}s)`);
  // initial delay to let tmux sessions stabilize
  setTimeout(() => {
    scanOnce(adminToken).catch(() => {});
    globalState.claudeSessionTaskHandle = setInterval(() => {
      scanOnce(adminToken).catch(() => {});
    }, intervalSeconds * 1000) as any;
  }, 3000);
}

export function stopClaudeSessionMonitor(): void {
  if (globalState.claudeSessionTaskHandle) {
    clearInterval(globalState.claudeSessionTaskHandle);
    globalState.claudeSessionTaskHandle = null;
    console.log('🛑 Stopped Claude session monitor');
  }
} 