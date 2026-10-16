/**
 * Public event names and payloads (docs/API.md §2). Pure types plus one
 * helper that builds a frozen payload, so listeners can't mutate what the
 * next listener sees.
 */

export type WadjetEvent = "ready" | "profiles-changed" | "time-changed" | "adapters-changed" | "resolvers-changed" | "interpreters-changed" | "unload";

export interface ReadyPayload {
  readonly type: "ready";
}
export interface ProfilesChangedPayload {
  readonly type: "profiles-changed";
  /** true when the seed, the era timeline or the descriptor bands changed: every zone's weather may have moved */
  readonly all: boolean;
  /** zones whose weather may have changed (added and removed zones included); every current id when `all` is true */
  readonly zoneIds: readonly string[];
}
export interface TimeChangedPayload {
  readonly type: "time-changed";
  /** `now()?.dayOrdinal` at the moment of the event, or null when the active calendar has no current day */
  readonly current: number | null;
  /** the id of the active time adapter */
  readonly adapterId: string;
}
export interface AdaptersChangedPayload {
  readonly type: "adapters-changed";
}
export interface ResolversChangedPayload {
  readonly type: "resolvers-changed";
}
export interface InterpretersChangedPayload {
  readonly type: "interpreters-changed";
  /** the facet of the interpreter that was registered or unregistered */
  readonly facet: string;
}
export interface UnloadPayload {
  readonly type: "unload";
}

export interface WadjetEventPayloads {
  ready: ReadyPayload;
  "profiles-changed": ProfilesChangedPayload;
  "time-changed": TimeChangedPayload;
  "adapters-changed": AdaptersChangedPayload;
  "resolvers-changed": ResolversChangedPayload;
  "interpreters-changed": InterpretersChangedPayload;
  unload: UnloadPayload;
}

/** Every event name, in documentation order. */
export const WADJET_EVENTS: readonly WadjetEvent[] = ["ready", "profiles-changed", "time-changed", "adapters-changed", "resolvers-changed", "interpreters-changed", "unload"];

/** The payload minus `type`; `[]` when there is nothing else to pass. */
export type PayloadArgs<E extends WadjetEvent> = keyof Omit<WadjetEventPayloads[E], "type"> extends never ? [] : [Omit<WadjetEventPayloads[E], "type">];

/** A frozen payload object (arrays inside are frozen too). */
export function makePayload<E extends WadjetEvent>(event: E, rest?: object): WadjetEventPayloads[E] {
  const out: Record<string, unknown> = { type: event };
  for (const [k, v] of Object.entries(rest ?? {})) out[k] = Array.isArray(v) ? Object.freeze([...(v as unknown[])]) : v;
  return Object.freeze(out) as unknown as WadjetEventPayloads[E];
}
