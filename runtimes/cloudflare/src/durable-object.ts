/**
 * The exported Durable Object class (R1): the singleton substrate the
 * Workers entry forwards every request to. The class is a thin shell -
 * all behavior lives in {@link DurableObjectRuntime}, which runs
 * against narrow structural interfaces so tests can drive it without a
 * real workerd.
 */
import { DurableObjectRuntime } from './runtime'
import type { CloudflareEnv, DoAlarmLike, DoStorageLike, WebSocketHost } from './types'

/** Narrows the real storage surface to what the runtime consumes. */
function storageOf(storage: DurableObjectStorage): DoStorageLike {
  return {
    get: (key) => storage.get(key) as Promise<unknown>,
    put: (key, value) => storage.put(key, value as never),
    delete: (key) => storage.delete(key),
    list: (options) =>
      storage.list({ ...(options?.prefix === undefined ? {} : { prefix: options.prefix }) }) as unknown as Promise<
        Map<string, unknown>
      >,
  }
}

/** Narrows the alarm surface (one-shot alarms on the storage). */
function alarmOf(storage: DurableObjectStorage): DoAlarmLike {
  return {
    setAlarm: (scheduledAtMs) => storage.setAlarm(scheduledAtMs),
    getAlarm: () => storage.getAlarm(),
    deleteAlarm: () => storage.deleteAlarm(),
  }
}

/** WebSocket hibernation host over the Durable Object state. */
function socketHostOf(state: DurableObjectState): WebSocketHost {
  return {
    accept: (socket, tags) => state.acceptWebSocket(socket, tags === undefined ? undefined : [...tags]),
    list: (tag) => state.getWebSockets(tag),
  }
}

export class CpaEdgeDurableObject {
  private readonly runtime: DurableObjectRuntime

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    this.runtime = new DurableObjectRuntime({
      storage: storageOf(state.storage),
      alarm: alarmOf(state.storage),
      ...(typeof state.acceptWebSocket === 'function' ? { sockets: socketHostOf(state) } : {}),
      env: {
        ...(env.CPA_CONFIG === undefined ? {} : { configKv: env.CPA_CONFIG }),
        ...(env.CPA_CONFIG_YAML === undefined || env.CPA_CONFIG_YAML === ''
          ? {}
          : { configText: env.CPA_CONFIG_YAML }),
      },
    })
  }

  async fetch(request: Request): Promise<Response> {
    return this.runtime.fetch(request)
  }

  async alarm(): Promise<void> {
    await this.runtime.alarm()
  }
}
