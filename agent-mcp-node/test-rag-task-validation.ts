#!/usr/bin/env tsx
// Test script for RAG-assisted task creation validation

import { validateTaskPlacement } from './src/features/task_placement/validator.js';
import { formatSuggestionsForAgent } from './src/features/task_placement/suggestions.js';

async function testRagValidation() {
  console.log('🧪 Testing RAG Task Placement Validation');
  console.log('=' .repeat(50));

  try {
    // Test case 1: Basic task validation
    console.log('\n📝 Test 1: Basic task validation');
    const result1 = await validateTaskPlacement(
      'Fix authentication bug',
      'There is a bug in the user authentication system that prevents login',
      undefined, // No parent (root task attempt)
      [], // No dependencies
      'test-agent',
      'test-token'
    );

    console.log(`Status: ${result1.status}`);
    console.log(`Message: ${result1.message}`);
    
    const suggestion1 = formatSuggestionsForAgent(result1, undefined, []);
    console.log('Suggestions:');
    console.log(suggestion1);

    // Test case 2: Task with proposed parent
    console.log('\n📝 Test 2: Task with proposed parent');
    const result2 = await validateTaskPlacement(
      'Add user profile page',
      'Create a new user profile page with avatar upload functionality',
      'TASK-001', // Proposed parent
      ['TASK-002'], // Proposed dependency
      'test-agent',
      'test-token'
    );

    console.log(`Status: ${result2.status}`);
    console.log(`Message: ${result2.message}`);
    
    const suggestion2 = formatSuggestionsForAgent(result2, 'TASK-001', ['TASK-002']);
    console.log('Suggestions:');
    console.log(suggestion2);

    console.log('\n✅ RAG validation tests completed');

  } catch (error) {
    console.error('❌ Test failed:', error);
    console.log('\nThis is expected if RAG system is not fully set up or no tasks exist yet.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testRagValidation().catch(console.error);
}