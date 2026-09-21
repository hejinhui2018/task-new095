/**
 * 应用级状态：配载计划 + 跑道性能输入，附带撤销/重做历史。
 * 持久化使用 v2 键；旧版（k12-loadsheet-v1，仅配载）在首次启动时纯函数迁移。
 */

import { airports, findAirport } from '../lib/airports'
import type { Obstacle, SurfaceCondition } from '../lib/airports'
import type { PerfInput } from '../lib/performance'
import { coercePlannerState, createDefaultState, reducer as planReducer, type PlannerState } from './store'

export interface AppState {
  plan: PlannerState
  perf: PerfInput
}

export interface History {
  past: AppState[]
  present: AppState
  future: AppState[]
  /** 上一次连续输入的合并键（滑块拖动期间合并为一条历史） */
  coalesceKey?: string
}

/** 首屏内置场景：白山 17 号短湿跑道 + 默认航班（即使配载全绿也会因跑道性能被拦） */
export function createDefaultPerf(): PerfInput {
  return {
    airportId: 'ZLBS',
    runwayId: 'rwy17',
    endId: '17',
    surface: 'wet',
    oatC: 20,
    pressureAltFt: 2050,
    windDirDeg: 170,
    windSpeedKt: 10,
    slopeOverridePct: null,
    obstacleOverride: null,
  }
}

export function createDefaultAppState(): AppState {
  return { plan: createDefaultState(), perf: createDefaultPerf() }
}

export type PlanAction =
  | { type: 'assign'; itemId: string; stationId: string }
  | { type: 'unassign'; itemId: string }
  | { type: 'setFuel'; tankId: string; value: number }
  | { type: 'setBurn'; value: number }
  | { type: 'reset' }

export type AppAction =
  | (PlanAction & { coalesceKey?: string })
  | { type: 'setPerf'; patch: Partial<PerfInput>; coalesceKey?: string }
  | { type: 'breakCoalesce' }
  | { type: 'applyCandidate'; state: AppState }
  | { type: 'undo' }
  | { type: 'redo' }

const HISTORY_LIMIT = 100

function pushHistory(h: History, next: AppState, coalesceKey?: string): History {
  // 同一滑块/同一字段的连续变更合并，撤销时一次回退
  if (coalesceKey && h.coalesceKey === coalesceKey) {
    return { ...h, present: next, coalesceKey }
  }
  const past = [...h.past, h.present]
  if (past.length > HISTORY_LIMIT) past.shift()
  return { past, present: next, future: [], coalesceKey }
}

export function appReducer(h: History, action: AppAction): History {
  switch (action.type) {
    case 'undo': {
      if (h.past.length === 0) return h
      const previous = h.past[h.past.length - 1]
      return {
        past: h.past.slice(0, -1),
        present: previous,
        future: [h.present, ...h.future],
        coalesceKey: undefined,
      }
    }
    case 'redo': {
      if (h.future.length === 0) return h
      const [next, ...rest] = h.future
      return {
        past: [...h.past, h.present],
        present: next,
        future: rest,
        coalesceKey: undefined,
      }
    }
    case 'applyCandidate':
      return pushHistory(h, action.state)
    case 'breakCoalesce':
      return h.coalesceKey === undefined ? h : { ...h, coalesceKey: undefined }
    default:
      break
  }

  if (action.type === 'setPerf') {
    const next: AppState = { plan: h.present.plan, perf: { ...h.present.perf, ...action.patch } }
    return pushHistory(h, next, action.coalesceKey)
  }

  if (action.type === 'reset') {
    return pushHistory(h, createDefaultAppState())
  }

  const nextPlan = planReducer(h.present.plan, action)
  if (nextPlan === h.present.plan) return h
  const key = 'coalesceKey' in action ? action.coalesceKey : undefined
  return pushHistory(h, { plan: nextPlan, perf: h.present.perf }, key)
}

// ---------------- 持久化与迁移 ----------------

const STORAGE_KEY_V1 = 'k12-loadsheet-v1'
const STORAGE_KEY_V2 = 'k12-loadsheet-v2'

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function coercePerf(parsed: unknown): PerfInput {
  const base = createDefaultPerf()
  if (!parsed || typeof parsed !== 'object') return base
  const p = parsed as Partial<PerfInput>

  // 机场/跑道/方向必须在库中，否则回退默认场景
  const airport = typeof p.airportId === 'string' ? findAirport(p.airportId) : undefined
  const runway = airport?.runways.find((r) => r.id === p.runwayId)
  const end = runway?.ends.find((e) => e.id === p.endId)
  if (!airport || !runway || !end) return base

  const surface: SurfaceCondition = p.surface === 'dry' || p.surface === 'wet' ? p.surface : base.surface
  const oatC = isFiniteNumber(p.oatC) ? p.oatC : base.oatC
  const pressureAltFt = isFiniteNumber(p.pressureAltFt) ? p.pressureAltFt : base.pressureAltFt
  const windDirDeg = isFiniteNumber(p.windDirDeg) ? ((p.windDirDeg % 360) + 360) % 360 : base.windDirDeg
  const windSpeedKt = isFiniteNumber(p.windSpeedKt) ? Math.max(p.windSpeedKt, 0) : base.windSpeedKt

  const slopeOverridePct =
    p.slopeOverridePct === null
      ? null
      : isFiniteNumber(p.slopeOverridePct)
        ? p.slopeOverridePct
        : base.slopeOverridePct

  let obstacleOverride: Obstacle | null = null
  if (p.obstacleOverride === null) {
    obstacleOverride = null
  } else if (
    p.obstacleOverride &&
    typeof p.obstacleOverride === 'object' &&
    isFiniteNumber((p.obstacleOverride as Obstacle).heightFt) &&
    isFiniteNumber((p.obstacleOverride as Obstacle).distanceFt)
  ) {
    obstacleOverride = {
      heightFt: (p.obstacleOverride as Obstacle).heightFt,
      distanceFt: (p.obstacleOverride as Obstacle).distanceFt,
    }
  } else {
    obstacleOverride = base.obstacleOverride
  }

  return {
    airportId: airport.id,
    runwayId: runway.id,
    endId: end.id,
    surface,
    oatC,
    pressureAltFt,
    windDirDeg,
    windSpeedKt,
    slopeOverridePct,
    obstacleOverride,
  }
}

/** v1（仅配载）→ v2（配载 + 默认短湿跑道性能输入）纯迁移函数 */
export function migrateV1ToV2(rawV1: unknown): AppState {
  return { plan: coercePlannerState(rawV1), perf: createDefaultPerf() }
}

/** v2 JSON → AppState（逐字段校验，非法回退默认） */
export function coerceAppState(parsed: unknown): AppState {
  if (!parsed || typeof parsed !== 'object') return createDefaultAppState()
  const p = parsed as Partial<AppState>
  return {
    plan: coercePlannerState(p.plan),
    perf: coercePerf(p.perf),
  }
}

export function loadHistory(): History {
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2)
    if (rawV2) {
      const present = coerceAppState(JSON.parse(rawV2))
      return { past: [], present, future: [] }
    }
    const rawV1 = localStorage.getItem(STORAGE_KEY_V1)
    if (rawV1) {
      const present = migrateV1ToV2(JSON.parse(rawV1))
      return { past: [], present, future: [] }
    }
  } catch {
    // 存储损坏时回退默认
  }
  return { past: [], present: createDefaultAppState(), future: [] }
}

export function saveAppState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(state))
  } catch {
    // 存储不可用时静默忽略（如隐私模式）
  }
}

export { airports, STORAGE_KEY_V1, STORAGE_KEY_V2 }
