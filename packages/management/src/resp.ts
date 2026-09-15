/**
 * RESP usage wire (S6 section 4): the byte-exact protocol state machine
 * behind `openUsageWire`. Transport-agnostic - the node runtime binds this
 * to its multiplexed TCP listener; the frame logic lives here.
 *
 * Recorded frame contract (S6-07/08/09):
 *   AUTH <key>            -> +OK / -ERR invalid management key / -ERR protocol
 *                            error when the declared bulk length lies
 *   no AUTH + any command -> -NOAUTH Authentication required. (conn stays)
 *   SUBSCRIBE usage       -> *3 subscribe ack :1 + immediate
 *                            {"support_refresh":true} message
 *   SUBSCRIBE errors      -> *3 subscribe ack :1 (no initial message)
 *   LPOP/RPOP usage [n]   -> counted: *<k> + bulks (empty: *0);
 *                            uncounted: one bulk or $-1
 *   LPOP errors           -> -ERR unsupported channel 'errors'
 *   PING [payload]        -> *2 pong $<len> <payload> / pong $-1
 *   UNSUBSCRIBE <ch>      -> *3 unsubscribe ack :0, then server close
 *   QUIT                  -> subscribed: +OK + close; authed only:
 *                            -ERR unknown command 'quit'; unauth: NOAUTH
 *   unknown               -> -ERR unknown command '<lowercased>'
 */

export interface UsageWireConnection {
  send(bytes: Uint8Array): Promise<void>
  takeOutput(): Uint8Array
  serverClosed(): boolean
  close(): void
}

interface WireDeps {
  readonly verifyKey: (presented: string) => Promise<boolean>
  readonly popRecords: (count: number) => Promise<string[]>
  readonly popRecord: () => Promise<string | undefined>
  /** Registers the live-payload sink of one subscribed connection. */
  readonly subscribe: (channel: 'usage' | 'errors', deliver: (payload: string) => void) => void
  readonly unsubscribe: (channel: 'usage' | 'errors') => void
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function simple(value: string): Uint8Array {
  return encoder.encode(`+${value}\r\n`)
}

function errorFrame(value: string): Uint8Array {
  return encoder.encode(`-${value}\r\n`)
}

function byteLengthOf(value: string): number {
  return encoder.encode(value).length
}

function bulk(value: string): Uint8Array {
  return encoder.encode(`$${byteLengthOf(value)}\r\n${value}\r\n`)
}

function nilBulk(): Uint8Array {
  return encoder.encode('$-1\r\n')
}

function integer(value: number): Uint8Array {
  return encoder.encode(`:${value}\r\n`)
}

/** Builds `*<n>` followed by `n` pre-encoded frames. */
function array(frames: readonly Uint8Array[]): Uint8Array {
  const head = encoder.encode(`*${frames.length}\r\n`)
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Uint8Array(head.length + total)
  out.set(head, 0)
  let offset = head.length
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/**
 * One connection's reader: buffers incoming bytes and yields complete RESP
 * commands with their declared-vs-actual bulk length (the $12-vs-$13
 * protocol-error contract).
 */
class RespReader {
  private buffer = new Uint8Array(0)

  append(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + bytes.length)
    merged.set(this.buffer, 0)
    merged.set(bytes, this.buffer.length)
    this.buffer = merged
  }

  /** Next complete command, or undefined when more bytes are needed. */
  next(): { readonly args: string[]; readonly protocolError: boolean } | undefined {
    const lines = this.findLineEnd(0)
    if (lines === undefined) return undefined
    const [type, rest] = lines
    if (type !== '*') {
      this.buffer = this.buffer.slice(rest)
      return { args: [], protocolError: true }
    }
    let offset = rest
    const countLine = this.readLine(offset)
    if (countLine === undefined) return undefined
    const count = Number(decoder.decode(countLine.text))
    if (!Number.isInteger(count) || count < 0) {
      this.buffer = this.buffer.slice(countLine.next)
      return { args: [], protocolError: true }
    }
    offset = countLine.next
    const args: string[] = []
    for (let i = 0; i < count; i += 1) {
      const dollarLine = this.readLine(offset)
      if (dollarLine === undefined) return undefined
      const dollar = decoder.decode(dollarLine.text)
      if (!dollar.startsWith('$')) {
        this.buffer = this.buffer.slice(dollarLine.next)
        return { args: [], protocolError: true }
      }
      const declared = Number(dollar.slice(1))
      if (!Number.isInteger(declared)) {
        this.buffer = this.buffer.slice(dollarLine.next)
        return { args: [], protocolError: true }
      }
      if (declared === -1) {
        offset = dollarLine.next
        args.push('')
        continue
      }
      const payloadEnd = this.findCrlf(dollarLine.next, declared)
      if (payloadEnd === undefined) return undefined
      const actualLength = payloadEnd - dollarLine.next
      args.push(decoder.decode(this.buffer.slice(dollarLine.next, payloadEnd)))
      offset = payloadEnd + 2
      if (actualLength !== declared) {
        // Tolerant framing consumed the payload; the mismatch answers later.
        this.buffer = this.buffer.slice(offset)
        return { args, protocolError: true }
      }
    }
    this.buffer = this.buffer.slice(offset)
    return { args, protocolError: false }
  }

  private findLineEnd(from: number): [string, number] | undefined {
    const end = this.findCrlf(from, 1)
    if (end === undefined) return undefined
    const text = decoder.decode(this.buffer.slice(from, end))
    return [text, end + 2]
  }

  private readLine(from: number): { readonly text: Uint8Array; readonly next: number } | undefined {
    const end = this.findCrlf(from, 1)
    if (end === undefined) return undefined
    return { text: this.buffer.slice(from, end), next: end + 2 }
  }

  /** Index of the CRLF that terminates a `declared`-byte payload. */
  private findCrlf(from: number, declared: number): number | undefined {
    for (let i = from; i + 1 < this.buffer.length; i += 1) {
      if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
        if (declared === 1) return i
        if (i - from >= declared) return i
      }
    }
    return undefined
  }
}

/** Creates one fresh connection state machine. */
export function openUsageWireConnection(deps: WireDeps): UsageWireConnection {
  const reader = new RespReader()
  let output: Uint8Array[] = []
  let authenticated = false
  let subscribed: 'usage' | 'errors' | undefined
  let closed = false

  const emit = (frame: Uint8Array): void => {
    output.push(frame)
  }

  const handleCommand = async (args: readonly string[]): Promise<void> => {
    const command = (args[0] ?? '').toLowerCase()
    if (!authenticated) {
      if (command === 'auth') {
        // AUTH itself is allowed pre-auth (it IS the authentication).
        await handleAuth(args)
        return
      }
      emit(errorFrame('NOAUTH Authentication required.'))
      return
    }
    switch (command) {
      case 'auth':
        await handleAuth(args)
        return
      case 'subscribe': {
        const channel = (args[1] ?? '').toLowerCase()
        if (channel !== 'usage' && channel !== 'errors') {
          emit(errorFrame(`unsupported channel '${channel}'`))
          return
        }
        if (subscribed !== undefined) {
          emit(errorFrame(`ERR already subscribed to '${subscribed}'`))
          return
        }
        subscribed = channel
        deps.subscribe(channel, (payload: string): void => {
          emit(array([bulk('message'), bulk(channel), bulk(payload)]))
        })
        emit(array([bulk('subscribe'), bulk(channel), integer(1)]))
        if (channel === 'usage') {
          emit(array([bulk('message'), bulk(channel), bulk('{"support_refresh":true}')]))
        }
        return
      }
      case 'unsubscribe': {
        const channel = (args[1] ?? '').toLowerCase()
        if (channel !== 'usage' && channel !== 'errors') {
          emit(errorFrame(`unsupported channel '${channel}'`))
          return
        }
        if (subscribed === undefined) {
          emit(errorFrame('ERR not subscribed to any channel'))
          return
        }
        subscribed = undefined
        deps.unsubscribe(channel)
        emit(array([bulk('unsubscribe'), bulk(channel), integer(0)]))
        closed = true
        return
      }
      case 'ping': {
        const payload = args[1]
        emit(array([bulk('pong'), payload === undefined ? nilBulk() : bulk(payload)]))
        return
      }
      case 'lpop':
      case 'rpop': {
        const channel = (args[1] ?? '').toLowerCase()
        if (channel === 'errors') {
          emit(errorFrame(`unsupported channel 'errors'`))
          return
        }
        if (channel !== 'usage') {
          emit(errorFrame(`unsupported channel '${channel}'`))
          return
        }
        if (args.length === 2) {
          const record = await deps.popRecord()
          if (record === undefined) emit(nilBulk())
          else emit(bulk(record))
          return
        }
        if (args.length === 3) {
          const count = Number(args[2])
          if (!Number.isInteger(count) || count <= 0) {
            emit(errorFrame('ERR value is not an integer or out of range'))
            return
          }
          const records = await deps.popRecords(count)
          emit(array(records.map((record) => bulk(record))))
          return
        }
        emit(errorFrame(`ERR wrong number of arguments for '${command}' command`))
        return
      }
      case 'quit': {
        if (subscribed !== undefined) {
          emit(simple('OK'))
          closed = true
          return
        }
        emit(errorFrame("ERR unknown command 'quit'"))
        return
      }
      default:
        emit(errorFrame(`ERR unknown command '${command}'`))
        return
    }
  }

  const handleAuth = async (args: readonly string[]): Promise<void> => {
    if (args.length < 2) {
      emit(errorFrame("ERR wrong number of arguments for 'auth' command"))
      return
    }
    const presented = args.length >= 3 ? (args[2] ?? '') : (args[1] ?? '')
    const ok = await deps.verifyKey(presented)
    if (!ok) {
      emit(errorFrame('ERR invalid management key'))
      return
    }
    authenticated = true
    emit(simple('OK'))
  }

  return {
    async send(bytes: Uint8Array): Promise<void> {
      if (closed) return
      reader.append(bytes)
      for (;;) {
        const next = reader.next()
        if (next === undefined) return
        if (next.protocolError) {
          emit(errorFrame('ERR protocol error'))
          continue
        }
        await handleCommand(next.args)
      }
    },
    takeOutput(): Uint8Array {
      const chunks = output
      output = []
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    },
    serverClosed(): boolean {
      return closed
    },
    close(): void {
      if (subscribed !== undefined) deps.unsubscribe(subscribed)
      closed = true
    },
  }
}
