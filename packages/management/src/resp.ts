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

/**
 * Injectables of one connection state machine: the key pipeline verdict,
 * the destructive record pops and the live-subscription hooks. Runtimes
 * binding the RESP protocol to their own transport supply these.
 */
export interface UsageWireDeps {
  /** Verdict of the management-key pipeline; failures carry the HTTP body message. */
  readonly verifyKey: (presented: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>
  readonly popRecords: (count: number) => Promise<string[]>
  readonly popRecord: () => Promise<string | undefined>
  /** Registers the live-payload sink of one subscribed connection. */
  readonly subscribe: (channel: 'usage' | 'errors', deliver: (payload: string) => void) => void
  /** Removes exactly the sink that `subscribe` registered for this connection. */
  readonly unsubscribe: (channel: 'usage' | 'errors', deliver: (payload: string) => void) => void
}

/** Live records one connection may buffer undrained before it is dropped (S6 3.5.3). */
const SUBSCRIBER_BUFFER_RECORDS = 256

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
    const first = this.findLineEnd(0)
    if (first === undefined) return undefined
    const [head, after] = first
    if (!head.startsWith('*')) {
      this.buffer = this.buffer.slice(after)
      return { args: [], protocolError: true }
    }
    const count = Number(head.slice(1))
    if (!Number.isInteger(count) || count < 0) {
      this.buffer = this.buffer.slice(after)
      return { args: [], protocolError: true }
    }
    let offset = after
    const args: string[] = []
    for (let i = 0; i < count; i += 1) {
      const header = this.readLine(offset)
      if (header === undefined) return undefined
      const text = decoder.decode(header.text)
      if (!text.startsWith('$')) {
        this.buffer = this.buffer.slice(header.next)
        return { args: [], protocolError: true }
      }
      const declared = Number(text.slice(1))
      if (!Number.isInteger(declared)) {
        this.buffer = this.buffer.slice(header.next)
        return { args: [], protocolError: true }
      }
      if (declared === -1) {
        offset = header.next
        args.push('')
        continue
      }
      const payloadEnd = this.findCrlf(header.next, declared)
      if (payloadEnd === undefined) return undefined
      const actualLength = payloadEnd - header.next
      args.push(decoder.decode(this.buffer.slice(header.next, payloadEnd)))
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
export function openUsageWireConnection(deps: UsageWireDeps): UsageWireConnection {
  const reader = new RespReader()
  let output: Uint8Array[] = []
  let authenticated = false
  let subscribed: { readonly channel: 'usage' | 'errors'; readonly deliver: (payload: string) => void } | undefined
  let closed = false
  let bufferedRecords = 0

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
          emit(errorFrame(`ERR unsupported channel '${channel}'`))
          return
        }
        if (subscribed !== undefined) {
          emit(errorFrame(`ERR already subscribed to '${subscribed.channel}'`))
          return
        }
        const deliver = (payload: string): void => {
          if (bufferedRecords >= SUBSCRIBER_BUFFER_RECORDS) {
            // Slow subscriber: the connection is dropped and closed; the
            // record is not buffered and later records take the queue path.
            deps.unsubscribe(channel, deliver)
            subscribed = undefined
            closed = true
            return
          }
          bufferedRecords += 1
          emit(array([bulk('message'), bulk(channel), bulk(payload)]))
        }
        subscribed = { channel, deliver }
        deps.subscribe(channel, deliver)
        emit(array([bulk('subscribe'), bulk(channel), integer(1)]))
        if (channel === 'usage') {
          emit(array([bulk('message'), bulk(channel), bulk('{"support_refresh":true}')]))
        }
        return
      }
      case 'unsubscribe': {
        const channel = (args[1] ?? '').toLowerCase()
        if (channel !== 'usage' && channel !== 'errors') {
          emit(errorFrame(`ERR unsupported channel '${channel}'`))
          return
        }
        if (subscribed === undefined) {
          emit(errorFrame('ERR not subscribed to any channel'))
          return
        }
        const sink = subscribed
        subscribed = undefined
        deps.unsubscribe(sink.channel, sink.deliver)
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
          emit(errorFrame(`ERR unsupported channel 'errors'`))
          return
        }
        if (channel !== 'usage') {
          emit(errorFrame(`ERR unsupported channel '${channel}'`))
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
    const verdict = await deps.verifyKey(presented)
    if (!verdict.ok) {
      emit(errorFrame(`ERR ${verdict.message}`))
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
      bufferedRecords = 0
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
      if (subscribed !== undefined) {
        deps.unsubscribe(subscribed.channel, subscribed.deliver)
        subscribed = undefined
      }
      closed = true
    },
  }
}
