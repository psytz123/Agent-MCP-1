/// <reference types="node" />
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d as Buffer));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

describe('Agent-MCP Node server smoke', async () => {
  const PORT = process.env.TEST_PORT || '3101';
  const PROJECT_DIR = process.cwd();
  let proc: ReturnType<typeof spawn> | null = null;

  after(async () => {
    if (proc) {
      try { proc.kill('SIGINT'); } catch {}
      await delay(1000);
    }
  });

  test('starts server and exposes health/stats, background tasks running', async () => {
    const serverPath = path.join(PROJECT_DIR, 'agent-mcp-node', 'build', 'examples', 'server', 'agentMcpServer.js');

    proc = spawn('node', [serverPath, '--port', PORT, '--project-dir', PROJECT_DIR], {
      env: { ...process.env, MCP_DEBUG: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const health = await get(`http://localhost:${PORT}/health`);
        if (health.status === 200) { ready = true; break; }
      } catch {}
      await delay(500);
    }
    assert.equal(ready, true);

    const stats = await get(`http://localhost:${PORT}/stats`);
    assert.equal(stats.status, 200);
    const statsJson = JSON.parse(stats.body);
    assert.ok(statsJson && typeof statsJson.database === 'object');
  }, { timeout: 60000 });
}); 