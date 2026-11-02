/**
 * Client for CodeIsland's hook socket (`/tmp/codeisland-<uid>.sock`).
 *
 * Protocol: connect, write one JSON payload, half-close with `end()`, read the
 * reply until the island closes. Ordinary events answer `{}` immediately; a
 * `PermissionRequest` holds the connection open until a person decides in the
 * notch, then answers with `hookSpecificOutput.decision.behavior`.
 * @module dsh-codeisland-bridge/codeisland-socket
 */

import { createConnection } from 'node:net'
import { constants as fsConstants, statSync } from 'node:fs'

/** Default socket path CodeIsland listens on; `CODEISLAND_SOCKET_PATH` overrides it. */
export function defaultSocketPath() {
  const fromEnv = process.env.CODEISLAND_SOCKET_PATH
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return `/tmp/codeisland-${process.getuid?.() ?? 0}.sock`
}

/**
 * Read a decision out of an island reply.
 * @param {unknown} response - Parsed reply JSON.
 * @returns {'allow' | 'deny' | null} `allow` for allow/always, `deny` for deny, null when absent or unknown.
 */
export function parseDecision(response) {
  if (typeof response !== 'object' || response === null) return null
  const hook = /** @type {Record<string, unknown>} */ (response).hookSpecificOutput
  const decision = (typeof hook === 'object' && hook !== null
    ? /** @type {Record<string, unknown>} */ (hook).decision
    : /** @type {Record<string, unknown>} */ (response).decision)
  const behavior = typeof decision === 'object' && decision !== null
    ? /** @type {Record<string, unknown>} */ (decision).behavior
    : undefined
  if (typeof behavior !== 'string') return null
  const normalized = behavior.trim().toLowerCase()
  if (normalized === 'allow' || normalized === 'always') return 'allow'
  if (normalized === 'deny') return 'deny'
  return null
}

export class CodeIslandSocket {
  /** @type {string} */
  #path
  /** @type {number} */
  #connectTimeoutMs
  /** Set by {@link dispose}; no send is attempted afterwards. */
  #disposed = false

  /**
   * @param {{ socketPath?: string, connectTimeoutMs?: number }} [options]
   */
  constructor({ socketPath, connectTimeoutMs = 1_500 } = {}) {
    this.#path = socketPath ?? defaultSocketPath()
    this.#connectTimeoutMs = connectTimeoutMs
  }

  /** The socket path this client talks to. */
  get path() {
    return this.#path
  }

  /** Whether a Unix socket currently exists at {@link path}. */
  available() {
    if (this.#disposed) return false
    try {
      const info = statSync(this.#path)
      return (info.mode & fsConstants.S_IFMT) === fsConstants.S_IFSOCK
    } catch {
      return false
    }
  }

  /**
   * Send one hook payload and read the reply.
   * @param {Record<string, unknown>} payload - CodeIsland hook JSON.
   * @param {{ wait?: boolean, timeoutMs?: number }} [options] - `wait` holds for a decision when the event asks for one.
   * @returns {Promise<{ ok: boolean, response?: Record<string, unknown>, error?: string }>} Outcome; never rejects.
   */
  send(payload, { wait = false, timeoutMs } = {}) {
    if (this.#disposed) return Promise.resolve({ ok: false, error: 'disposed' })
    const timeout = wait ? (timeoutMs ?? 300_000) : this.#connectTimeoutMs
    return new Promise((resolve) => {
      let settled = false
      /** @type {Buffer[]} */
      const chunks = []
      const socket = createConnection(this.#path)
      /** @param {{ ok: boolean, response?: Record<string, unknown>, error?: string }} result */
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(result)
      }
      const timer = setTimeout(() => {
        finish({ ok: false, error: wait ? 'timeout' : 'connect_timeout' })
      }, timeout)
      socket.on('connect', () => {
        socket.write(JSON.stringify(payload))
        socket.end()
      })
      socket.on('data', (data) => {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      })
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text === '') return finish({ ok: true })
        try {
          finish({ ok: true, response: JSON.parse(text) })
        } catch {
          finish({ ok: true, response: { raw: text } })
        }
      })
      socket.on('error', (error) => {
        finish({ ok: false, error: /** @type {NodeJS.ErrnoException} */ (error).code ?? String(error) })
      })
    })
  }

  /** Stop sending. The client opens no persistent connection, so nothing else is held. */
  dispose() {
    this.#disposed = true
  }
}
