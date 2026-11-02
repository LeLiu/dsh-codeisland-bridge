import { strict as assert } from 'node:assert'
import { after, test } from 'node:test'
import { rmSync } from 'node:fs'
import { apply, normalize, textOf } from '../index.js'
import { eventually, fakeContext, fakeIsland, testSocketPath } from './helpers.mjs'

/** One test island shared by the cases below. */
const path = testSocketPath('plugin')
const island = await fakeIsland(path, (payload) => (
  payload.hook_event_name === 'PermissionRequest'
    ? { hookSpecificOutput: { decision: { behavior: payload.tool_name === 'DenyMe' ? 'deny' : 'allow' } } }
    : {}
))
after(async () => {
  await island.close()
  rmSync(path, { force: true })
})

const session = { id: 'session-1', header: { cwd: '/work/project' } }
const exec = { name: 'Bash', callId: 'call-1', arguments: { command: 'ls' }, agent: { id: 'session-1' } }

/** Plugin fixture: a fresh context + listener table wired to the shared island. */
function fixture(config = {}) {
  const harness = fakeContext()
  apply(harness.ctx, { socketPath: path, ...config })
  return harness
}

test('SessionStart carries the workspace and is sent once per session', async () => {
  const harness = fixture()
  const before = island.received.length
  harness.listener('session/created')(session)
  harness.listener('session/created')(session)
  await eventually(() => island.received.length === before + 1)
  const [payload] = island.received.slice(before)
  assert.equal(payload.hook_event_name, 'SessionStart')
  assert.equal(payload.session_id, 'session-1')
  assert.equal(payload.cwd, '/work/project')
  assert.equal(payload._source, 'dsh')
  harness.dispose()
})

test('UserPromptSubmit carries the prompt text and always delegates', async () => {
  const harness = fixture()
  const before = island.received.length
  let delegated = false
  const decision = await harness.listener('agent/pre-step')(
    { agent: { id: 'session-1' }, messages: [{ content: [{ type: 'text', text: '帮我看看构建' }] }] },
    () => { delegated = true; return { kind: 'enter' } },
  )
  assert.equal(delegated, true)
  assert.deepEqual(decision, { kind: 'enter' })
  await eventually(() => island.received.length === before + 1)
  assert.equal(island.received.at(-1).hook_event_name, 'UserPromptSubmit')
  assert.equal(island.received.at(-1).prompt, '帮我看看构建')
  harness.dispose()
})

test('PreToolUse omits tool arguments unless asked, and never blocks the agent', async () => {
  const harness = fixture()
  const before = island.received.length
  let delegated = false
  await harness.listener('tools/pre-execute')(exec, () => { delegated = true; return { kind: 'allow' } })
  assert.equal(delegated, true)
  await eventually(() => island.received.length === before + 1)
  const payload = island.received.at(-1)
  assert.equal(payload.hook_event_name, 'PreToolUse')
  assert.equal(payload.tool_name, 'Bash')
  assert.equal(payload.tool_use_id, 'call-1')
  assert.equal('tool_input' in payload, false)
  harness.dispose()
})

test('toolInput: true forwards the parsed arguments', async () => {
  const harness = fixture({ toolInput: true })
  const before = island.received.length
  await harness.listener('tools/pre-execute')(exec, () => ({ kind: 'allow' }))
  await eventually(() => island.received.length === before + 1)
  assert.deepEqual(island.received.at(-1).tool_input, { command: 'ls' })
  harness.dispose()
})

test('a failed tool becomes PostToolUseFailure', async () => {
  const harness = fixture()
  const before = island.received.length
  await harness.listener('tools/post-execute')(exec, { isError: true }, () => ({ kind: 'allow' }))
  await eventually(() => island.received.length === before + 1)
  assert.equal(island.received.at(-1).hook_event_name, 'PostToolUseFailure')
  harness.dispose()
})

test('Stop carries the session latest assistant text', async () => {
  const harness = fixture()
  harness.listener('session/event')(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已经跑完测试，全部通过' }] } },
  })
  const before = island.received.length
  await harness.listener('agent/turn-stopping')({ agent: { id: 'session-1' } })
  await eventually(() => island.received.length === before + 1)
  const payload = island.received.at(-1)
  assert.equal(payload.hook_event_name, 'Stop')
  assert.equal(payload.last_assistant_message, '已经跑完测试，全部通过')
  harness.dispose()
})

test('an approved PermissionRequest becomes allowed-once', async () => {
  const harness = fixture()
  const outcome = await harness.listener('approval/request')(
    { agent: { id: 'session-1' }, toolName: 'Bash', reason: 'run tests', callId: 'call-1' },
    () => 'unavailable',
  )
  assert.equal(outcome, 'allowed-once')
  harness.dispose()
})

test('a denied PermissionRequest becomes rejected', async () => {
  const harness = fixture()
  const outcome = await harness.listener('approval/request')(
    { agent: { id: 'session-1' }, toolName: 'DenyMe', reason: 'write outside workspace' },
    () => 'unavailable',
  )
  assert.equal(outcome, 'rejected')
  harness.dispose()
})

test('without an island the approval delegates instead of failing closed', async () => {
  const harness = fakeContext()
  apply(harness.ctx, { socketPath: testSocketPath('absent'), approvals: true })
  let delegated = false
  const outcome = await harness.listener('approval/request')(
    { agent: { id: 'session-1' }, toolName: 'Bash' },
    () => { delegated = true; return 'unavailable' },
  )
  assert.equal(delegated, true)
  assert.equal(outcome, 'unavailable')
  harness.dispose()
})

test('SessionEnd is sent on disposal', async () => {
  const harness = fixture()
  const start = island.received.length
  harness.listener('session/created')(session)
  await eventually(() => island.received.length === start + 1)
  const before = island.received.length
  harness.listener('session/disposed')(session)
  await eventually(() => island.received.length === before + 1)
  assert.equal(island.received.at(-1).hook_event_name, 'SessionEnd')
  harness.dispose()
})

test('textOf keeps text blocks only', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOf(undefined), '')
})

test('normalize rejects bad config loudly', () => {
  assert.throws(() => normalize({ source: '' }), /source/)
  assert.throws(() => normalize({ approvalTimeoutMs: -1 }), /approvalTimeoutMs/)
  assert.throws(() => normalize({ approvals: 'yes' }), /approvals/)
  assert.equal(normalize({}).source, 'dsh')
})
