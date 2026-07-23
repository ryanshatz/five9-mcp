// Zero-dependency sanity checks for the tool registry and its UI metadata.
// Run with `npm test` (node --test). Keeps the console/landing UI honest:
// every tool must have a group and a resolved write-flag, and the grouping
// metadata must not reference tools that don't exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_GROUPS, WRITE_TOOLS } from '../src/tools.js';

const toolNames = new Set(TOOLS.map((t) => t.name));
const groupedNames = TOOL_GROUPS.flatMap((g) => g.tools);

test('every tool belongs to exactly one UI group', () => {
  const counts = new Map();
  for (const n of groupedNames) counts.set(n, (counts.get(n) || 0) + 1);
  const missing = [...toolNames].filter((n) => !counts.has(n));
  const dupes = [...counts].filter(([, c]) => c > 1).map(([n]) => n);
  assert.deepEqual(missing, [], `tools with no UI group (add them to TOOL_GROUPS in tools.js): ${missing.join(', ')}`);
  assert.deepEqual(dupes, [], `tools listed in more than one UI group: ${dupes.join(', ')}`);
});

test('TOOL_GROUPS references only real tools', () => {
  const unknown = groupedNames.filter((n) => !toolNames.has(n));
  assert.deepEqual(unknown, [], `TOOL_GROUPS references tools that don't exist: ${unknown.join(', ')}`);
});

test('WRITE_TOOLS references only real tools', () => {
  const unknown = [...WRITE_TOOLS].filter((n) => !toolNames.has(n));
  assert.deepEqual(unknown, [], `WRITE_TOOLS references tools that don't exist: ${unknown.join(', ')}`);
});

test('every tool has a unique name', () => {
  assert.equal(toolNames.size, TOOLS.length, 'duplicate tool names in TOOLS');
});

test('every tool has a description and inputSchema', () => {
  for (const t of TOOLS) {
    assert.ok(t.description && typeof t.description === 'string', `${t.name} missing description`);
    assert.ok(t.inputSchema && t.inputSchema.type === 'object', `${t.name} missing/!object inputSchema`);
    assert.equal(typeof t.handler, 'function', `${t.name} missing handler`);
  }
});
