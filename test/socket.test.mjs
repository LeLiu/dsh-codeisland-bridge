import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, rmSync } from 'node:fs'
import { CodeIslandSocket, defaultSocketPath, parseDecision } from '../codeisland-socket.js'
import { fakeIsland, testSocketPath } from './helpers.mjs'

test('defaultSocketPath honours CODEISLAND_SOCKET_PATH', () => {
  const saved = process.env.CODEISLAND_SOCKET_PATH
  try {
    process.env.CODEISLAND_SOCKET_PATH = '/tmp/custom.sock'
    assert.equal(defaultSocketPath(), '/tmp/custom.sock')
    delete process.env.CODEISLAND_SOCKET_PATH
    assert.equal(defaultSocketPath(), `/tmp/codeisland-${process.getuid?.() ?? 0}.sock`)
  } finally {
    if (saved === undefined) delete process.env.CODEISLAND_SOCKET_PATH
    else process.env.CODEISLAND_SOCKET_PATH = saved
  }
})

test('send delivers one JSON payload and reads the reply', async () => {
  const path = testSocketPath('basic')
  const island = await fakeIsland(path)
  try {
    const client = new CodeIslandSocket({ socketPath: path })
    assert.equal(client.available(), true)
    const result = await client.send({ hook_event_name: 'SessionStart', session_id: 's1', _source: 'dsh' })
    assert.deepEqual(result, { ok: true, response: {} })
    assert.equal(island.received.length, 1)
    assert.equal(island.received[0].hook_event_name, 'SessionStart')
    assert.equal(island.received[0]._source, 'dsh')
  } finally {
    await island.close()
    rmSync(path, { force: true })
  }
})

test('a missing socket reports an error and never rejects', async () => {
  const path = testSocketPath('missing')
  rmSync(path, { force: true })
  const client = new CodeIslandSocket({ socketPath: path })
  assert.equal(client.available(), false)
  const result = await client.send({ hook_event_name: 'SessionStart' })
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
})

test('wait mode returns the decision and times out on a silent island', async () => {
  const path = testSocketPath('decision')
  const island = await fakeIsland(path, (payload) => (
    payload.hook_event_name === 'PermissionRequest'
      ? { hookSpecificOutput: { decision: { behavior: 'allow' } } }
      : undefined
  ))
  try {
    const client = new CodeIslandSocket({ socketPath: path })
    const allowed = await client.send({ hook_event_name: 'PermissionRequest' }, { wait: true, timeoutMs: 2_000 })
    assert.equal(parseDecision(allowed.response), 'allow')
    assert.equal(island.received.length, 1)
  } finally {
    await island.close()
    rmSync(path, { force: true })
  }
})

test('wait mode times out when the island never answers', async () => {
  const path = testSocketPath('silent')
  const island = await fakeIsland(path, () => undefined)
  try {
    const client = new CodeIslandSocket({ socketPath: path })
    const result = await client.send({ hook_event_name: 'PermissionRequest' }, { wait: true, timeoutMs: 150 })
    assert.deepEqual(result, { ok: false, error: 'timeout' })
  } finally {
    await island.close()
    rmSync(path, { force: true })
  }
})

test('parseDecision handles both response shapes and rejects junk', () => {
  assert.equal(parseDecision({ hookSpecificOutput: { decision: { behavior: 'allow' } } }), 'allow')
  assert.equal(parseDecision({ hookSpecificOutput: { decision: { behavior: 'always' } } }), 'allow')
  assert.equal(parseDecision({ decision: { behavior: 'deny' } }), 'deny')
  assert.equal(parseDecision({}), null)
  assert.equal(parseDecision({ hookSpecificOutput: { decision: { behavior: 'maybe' } } }), null)
  assert.equal(parseDecision(null), null)
  assert.equal(existsSync('/definitely/not/here'), false)
})
