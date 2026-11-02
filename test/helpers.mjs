/** Test doubles: a fake CodeIsland socket and a minimal cordis-like context. */
import { createServer } from 'node:net'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** A socket path unique to this test process. */
export function testSocketPath(name = 'island') {
  return join(tmpdir(), `dsh-codeisland-${name}-${process.pid}.sock`)
}

/**
 * Start a fake island server that records payloads and replies.
 * @param {string} sockPath - Unix socket path to bind.
 * @param {(payload: any) => any} [reply] - Reply object per payload; return undefined to stay silent.
 * @returns {Promise<{ received: any[], close: () => Promise<void> }>}
 */
export async function fakeIsland(sockPath, reply = () => ({})) {
  rmSync(sockPath, { force: true })
  /** @type {any[]} */
  const received = []
  /** @type {Set<any>} */
  const connections = new Set()
  // allowHalfOpen keeps a silent connection open after the client half-closes.
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    /** @type {Buffer[]} */
    const chunks = []
    conn.on('data', (data) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)))
    conn.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { raw: text }
      }
      received.push(payload)
      const out = reply(payload)
      // `undefined` means "stay silent": keep the connection open so a waiting
      // client hits its own timeout instead of reading an empty ack.
      if (out === undefined) return
      conn.write(JSON.stringify(out))
      conn.end()
    })
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    conn.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(sockPath, resolve))
  return {
    received,
    close: () => new Promise((resolve) => {
      for (const conn of connections) conn.destroy()
      connections.clear()
      server.close(() => resolve())
    }),
  }
}

/** A cordis-like context that records listeners and effects. */
export function fakeContext() {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map()
  /** @type {Function[]} */
  const teardowns = []
  const warnings = []
  return {
    handlers,
    warnings,
    /** Listener registered for `name` (throws when absent). */
    listener(name) {
      const list = handlers.get(name)
      if (list === undefined || list.length === 0) throw new Error(`no listener for ${name}`)
      return list[0]
    },
    ctx: {
      on(name, listener) {
        handlers.set(name, [...handlers.get(name) ?? [], listener])
        return () => {}
      },
      effect(setup) {
        teardowns.push(setup())
      },
      logger: {
        warn(message) {
          warnings.push(message)
        },
      },
    },
    dispose() {
      for (const teardown of teardowns) teardown?.()
    },
  }
}

/** Wait until `predicate` holds, or fail after `timeoutMs`. */
export async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not met in time')
}
