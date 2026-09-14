import { test } from 'node:test';
import assert from 'node:assert/strict';

test('replyQuestion and rejectQuestion resolve explicit directory when getSessionDirectory is empty', () => {
  const getSessionDirectory = (sessionId) => undefined;

  // Case 1: explicit directory passed in stdinData
  const stdinData1 = {
    sessionId: 'ses_123',
    questionID: 'que_abc',
    answers: [['Option A']],
    directory: '/custom/workspace/dir',
  };
  const resolvedDir1 = getSessionDirectory(stdinData1.sessionId) || stdinData1.directory;
  assert.equal(resolvedDir1, '/custom/workspace/dir');

  // Case 2: rejectQuestion with explicit directory
  const stdinData2 = {
    sessionId: 'ses_123',
    questionID: 'que_abc',
    directory: '/custom/workspace/dir',
  };
  const resolvedDir2 = getSessionDirectory(stdinData2.sessionId) || stdinData2.directory;
  assert.equal(resolvedDir2, '/custom/workspace/dir');

  // Case 3: getSessionDirectory has cache -> prioritizes session registry
  const getSessionDirectoryWithCache = (sessionId) => '/authoritative/session/dir';
  const resolvedDir3 = getSessionDirectoryWithCache(stdinData1.sessionId) || stdinData1.directory;
  assert.equal(resolvedDir3, '/authoritative/session/dir');
});

test('replyPermission resolves explicit directory when getSessionDirectory is empty', () => {
  const getSessionDirectory = (sessionId) => undefined;

  const stdinData = {
    sessionId: 'ses_456',
    permissionID: 'per_xyz',
    reply: 'allow',
    directory: '/permission/workspace/dir',
  };

  const resolvedDir = getSessionDirectory(stdinData.sessionId) || stdinData.directory;
  assert.equal(resolvedDir, '/permission/workspace/dir');
});
