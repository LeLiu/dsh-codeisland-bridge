/**
 * dsh-codeisland-bridge — forward DeepSeek Harness agent activity to CodeIsland.
 *
 * Every hook below becomes the CodeIsland hook JSON the island already ingests
 * from its own bridge: one payload per event, `_source: "dsh"` so the card is
 * labelled DeepSeek Harness. This plugin sends no reader and starts no panel —
 * what CodeIsland shows is exactly what is sent here.
 *
 * Non-blocking events (`SessionStart`, prompts, tools, `Stop`, subagents) are
 * fire-and-forget. Only `PermissionRequest` waits, because the answer feeds the
 * tool decision; when the island is absent or slow the request delegates to the
 * next answerer instead of failing closed here.
 * @module dsh-codeisland-bridge
 */

import { CodeIslandSocket, parseDecision } from './codeisland-socket.js'

export const name = 'codeisland-bridge'

/** Defaults for every accepted config field. */
export const DEFAULTS = Object.freeze({
  /** CodeIsland source label; the island maps `dsh` to DeepSeek Harness. */
  source: 'dsh',
  /** Forward `approval/request` to the notch and apply its decision. */
  approvals: true,
  /** How long an approval may hold before delegating. */
  approvalTimeoutMs: 300_000,
  /** Connect/ack budget for fire-and-forget events. */
  connectTimeoutMs: 1_500,
  /** Report subagent start/stop. */
  subagents: true,
  /** Include the tool's parsed arguments in `PreToolUse`. */
  toolInput: false,
  /** Cap for the assistant text attached to `Stop`. */
  maxReplyChars: 4_000,
})

/**
 * Register the plugin's listeners.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Record<string, unknown>} [config] - Plugin config; unknown keys are ignored.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const options = normalize(config)
  const client = new CodeIslandSocket({
    socketPath: options.socketPath,
    connectTimeoutMs: options.connectTimeoutMs,
  })
  /** session id → creation facts; also the duplicate-`SessionStart` guard. */
  const sessions = new Map()
  /** session id → latest assistant text, already truncated. */
  const replies = new Map()
  /** @param {string} message */
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`codeisland-bridge: ${message}`)
    } catch { /* logging must never break the agent */ }
  }

  ctx.effect(() => () => {
    sessions.clear()
    replies.clear()
    client.dispose()
  })

  /** @param {Record<string, unknown>} payload */
  const send = (payload) => {
    void client.send(payload).catch((error) => warn(`send failed: ${String(error)}`))
  }

  /**
   * Base fields every payload carries.
   * @param {string} sessionId
   * @returns {Record<string, unknown>}
   */
  const base = (sessionId) => ({
    session_id: sessionId,
    cwd: sessions.get(sessionId)?.cwd ?? process.cwd(),
    _source: options.source,
  })

  ctx.on('session/created', (session) => {
    const id = sessionIdOf(session)
    if (id === undefined || sessions.has(id)) return
    sessions.set(id, { cwd: session?.header?.cwd })
    send({ hook_event_name: 'SessionStart', ...base(id) })
  })

  ctx.on('session/disposed', (session) => {
    const id = sessionIdOf(session)
    if (id === undefined) return
    const payload = { hook_event_name: 'SessionEnd', ...base(id) }
    sessions.delete(id)
    replies.delete(id)
    send(payload)
  })

  // The island cannot read a DSH transcript, so the reply it shows on `Stop`
  // is whatever this plugin captured from the session's own event log.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const id = sessionIdOf(session)
    if (id === undefined) return
    const text = textOf(event.data?.message?.content).trim()
    if (text !== '') replies.set(id, text.slice(0, options.maxReplyChars))
  }, { global: true })

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    try {
      const id = agentIdOf(agent)
      const prompt = (messages ?? []).map((message) => textOf(message?.content)).join('\n').trim()
      if (id !== undefined && prompt !== '') {
        send({ hook_event_name: 'UserPromptSubmit', prompt, ...base(id) })
      }
    } catch (error) {
      warn(`UserPromptSubmit: ${String(error)}`)
    }
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const payload = toolPayload('PreToolUse', exec, options, base)
      if (payload !== undefined) send(payload)
    } catch (error) {
      warn(`PreToolUse: ${String(error)}`)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const event = result?.isError === true ? 'PostToolUseFailure' : 'PostToolUse'
      const payload = toolPayload(event, exec, options, base)
      if (payload !== undefined) send(payload)
    } catch (error) {
      warn(`PostToolUse: ${String(error)}`)
    }
    return next()
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    try {
      const id = agentIdOf(agent)
      if (id === undefined) return
      const reply = replies.get(id)
      send({
        hook_event_name: 'Stop',
        stop_hook_active: false,
        ...reply === undefined ? {} : { last_assistant_message: reply },
        ...base(id),
      })
    } catch (error) {
      warn(`Stop: ${String(error)}`)
    }
  })

  if (options.subagents) {
    ctx.on('subagent/start', (info) => {
      const payload = subagentPayload('SubagentStart', info, base)
      if (payload !== undefined) send(payload)
    })
    ctx.on('subagent/end', (info) => {
      const payload = subagentPayload('SubagentStop', info, base)
      if (payload !== undefined) send(payload)
    })
  }

  if (options.approvals) {
    ctx.on('approval/request', async (request, next) => {
      try {
        const id = agentIdOf(request?.agent)
        if (id === undefined || !client.available()) return next()
        const result = await client.send({
          hook_event_name: 'PermissionRequest',
          tool_name: request?.toolName,
          ...request?.callId === undefined ? {} : { tool_use_id: request.callId },
          ...request?.reason === undefined ? {} : { question: request.reason },
          ...base(id),
        }, { wait: true, timeoutMs: options.approvalTimeoutMs })
        const decision = parseDecision(result.response)
        if (decision === 'allow') return 'allowed-once'
        if (decision === 'deny') return 'rejected'
      } catch (error) {
        warn(`PermissionRequest: ${String(error)}`)
      }
      return next()
    })
  }
}

/**
 * Build a tool-event payload, or nothing when the call has no session to attribute.
 * @param {'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'} event - Island event name.
 * @param {any} exec - Tool execution.
 * @param {ReturnType<typeof normalize>} options - Resolved config.
 * @param {(sessionId: string) => Record<string, unknown>} base - Base-field builder for that session.
 * @returns {Record<string, unknown> | undefined}
 */
function toolPayload(event, exec, options, base) {
  const id = agentIdOf(exec?.agent)
  if (id === undefined) return undefined
  return {
    hook_event_name: event,
    ...base(id),
    tool_name: exec?.name,
    ...exec?.callId === undefined ? {} : { tool_use_id: exec.callId },
    ...options.toolInput ? { tool_input: exec?.arguments } : {},
  }
}

/**
 * Build a subagent payload from the subagent seam's run identity.
 * @param {'SubagentStart' | 'SubagentStop'} event - Island event name.
 * @param {any} info - Subagent start/end info.
 * @param {(sessionId: string) => Record<string, unknown>} base - Base-field builder for that session.
 * @returns {Record<string, unknown> | undefined}
 */
function subagentPayload(event, info, base) {
  const id = typeof info?.id === 'string' ? info.id : undefined
  if (id === undefined) return undefined
  return {
    hook_event_name: event,
    ...base(id),
    ...typeof info?.runId === 'string' ? { agent_id: info.runId } : {},
    agent_type: 'subagent',
    stop_hook_active: false,
  }
}

/**
 * Concatenate the text blocks of one message's content.
 * @param {unknown} content - Content blocks (or anything else).
 * @returns {string}
 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** @param {any} session */
function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** @param {any} agent */
function agentIdOf(agent) {
  return typeof agent?.id === 'string' && agent.id !== '' ? agent.id : undefined
}

/**
 * Validate and default the plugin config.
 * @param {Record<string, unknown>} config - Raw loader config.
 * @returns {Record<string, any>} Resolved options.
 */
export function normalize(config) {
  const options = { ...DEFAULTS, ...config }
  if (typeof options.source !== 'string' || options.source.trim() === '') {
    throw new Error('codeisland-bridge: source must be a non-empty string')
  }
  if (options.socketPath !== undefined && (typeof options.socketPath !== 'string' || options.socketPath === '')) {
    throw new Error('codeisland-bridge: socketPath must be a non-empty string')
  }
  for (const key of ['approvalTimeoutMs', 'connectTimeoutMs', 'maxReplyChars']) {
    if (typeof options[key] !== 'number' || !Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`codeisland-bridge: ${key} must be a positive number`)
    }
  }
  for (const key of ['approvals', 'subagents', 'toolInput']) {
    if (typeof options[key] !== 'boolean') throw new Error(`codeisland-bridge: ${key} must be a boolean`)
  }
  return options
}
