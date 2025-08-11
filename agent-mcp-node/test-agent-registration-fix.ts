#!/usr/bin/env tsx
// Test script to verify agent registration and file status update fixes

import { getDbConnection } from './src/db/connection.js';
import { generateTestingAgent } from './src/utils/testingAgent.js';

async function testAgentRegistrationFix() {
  console.log('🧪 Testing Agent Registration & File Status Fix\n');

  try {
    // 1. Test agent creation and registration
    console.log('1️⃣ Testing agent creation...');
    const result = await generateTestingAgent('completed-by-test', 'TEST-TASK-001');
    
    if (!result.success) {
      console.error('❌ Agent creation failed:', result.error);
      return;
    }
    
    console.log(`✅ Agent created: ${result.testing_agent_id}`);
    
    // 2. Verify agent exists in database
    console.log('\n2️⃣ Verifying agent in database...');
    const db = getDbConnection();
    const agent = db.prepare('SELECT agent_id, status, token FROM agents WHERE agent_id = ?').get(result.testing_agent_id) as any;
    
    if (!agent) {
      console.error('❌ Agent not found in database');
      return;
    }
    
    console.log(`✅ Agent verified in database: ${agent.agent_id} (status: ${agent.status})`);
    
    // 3. Test file status update with the agent
    console.log('\n3️⃣ Testing file status update...');
    
    // Import the updateFileStatus function
    const { updateFileStatus } = await import('./src/tools/file_management.js');
    
    const testFilePath = '/tmp/test-file.txt';
    const updateResult = await updateFileStatus({
      filepath: testFilePath,
      status: 'in_use',
      agent_id: result.testing_agent_id,
      notes: 'Testing agent registration fix'
    });
    
    console.log('Update result:', JSON.stringify(updateResult, null, 2));
    
    if (updateResult.isError) {
      console.error('❌ File status update failed');
    } else {
      console.log('✅ File status update succeeded');
    }
    
    // 4. Cleanup - remove test agent
    console.log('\n4️⃣ Cleaning up test agent...');
    
    // Clean up related records first to avoid foreign key constraints
    db.prepare('DELETE FROM file_status WHERE agent_id = ?').run(result.testing_agent_id);
    db.prepare('DELETE FROM agent_actions WHERE agent_id = ?').run(result.testing_agent_id);
    
    const deleteResult = db.prepare('DELETE FROM agents WHERE agent_id = ?').run(result.testing_agent_id);
    
    if (deleteResult.changes > 0) {
      console.log('✅ Test agent cleaned up');
    }
    
    // Kill the tmux session as well
    try {
      const sessionName = `${result.testing_agent_id.slice(0, 8)}-148f`;
      console.log(`🧹 Killing tmux session: ${sessionName}`);
      const { execSync } = await import('child_process');
      execSync(`tmux kill-session -t "${sessionName}"`, { timeout: 5000 });
      console.log('✅ Tmux session cleaned up');
    } catch (error) {
      console.log('ℹ️ Tmux session cleanup completed (may have been auto-cleaned)');
    }
    
    console.log('\n🎉 Test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testAgentRegistrationFix().catch(console.error);
}