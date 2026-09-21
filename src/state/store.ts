import { aircraft } from '../lib/aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from '../lib/manifest'
import { buildStationMap } from '../lib/weightBalance'
import {
  getAirport,
  getRunway,
  type SurfaceState,
} from '../lib/performanceData'
import { defaultPerfInput, type PerfInput } from '../lib/performance'

/** 配载方案状态（会被持久化到 localStorage） */
export interface PlannerState {
  /** itemId -> 站位 id（座位号或行李舱 id）；缺失表示未装载 */
  assignments: Record<string, string>
  /** tankId -> 载油量 lb */
  fuel: Record<string, number>
  /** 预计航程耗油 lb */
  burn: number
  /** 跑道性能放行输入 */
  perf: PerfInput
}

/** 连续输入（滑块拖动、数字微调）合并历史所用的键；同键连续动作只产生一个撤销点 */
export type CoalesceKey = 'fuel' | 'burn' | 'perf'

export type Action =
  | { type: 'assign'; itemId: string; stationId: string }
  | { type: 'unassign'; itemId: string }
  | { type: 'setFuel'; tankId: string; value: number; coalesceKey?: CoalesceKey }
  | { type: 'setBurn'; value: number; coalesceKey?: CoalesceKey }
  | { type: 'setPerf'; patch: Partial<PerfInput>; coalesceKey?: CoalesceKey }
  | { type: 'applyPlan'; plan: PlannerState }
  | { type: 'reset' }

const stations = buildStationMap(aircraft)
const itemsById = new Map(manifestItems.map((i) => [i.id, i]))
const totalCapacity = aircraft.fuelTanks.reduce((s, t) => s + t.capacity, 0)

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)

export function createDefaultState(): PlannerState {
  return {
    assignments: { ...defaultAssignments },
    fuel: { ...defaultFuel },
    burn: defaultBurn,
    perf: defaultPerfInput(),
  }
}

/** 校验一次分配是否合法：乘客只能坐座位，行李只能进行李舱 */
function isLegalPlacement(itemId: string, stationId: string): boolean {
  const item = itemsById.get(itemId)
  const station = stations.get(stationId)
  if (!item || !station) return false
  if (station.kind === 'seat') return item.kind === 'pax'
  return item.kind === 'bag'
}

/** 性能输入的宽 sanity 边界：允许超出性能表覆盖范围（交由放行计算明确拒绝），只挡非法输入 */
const PERF_BOUNDS = {
  temperature: [-60, 60],
  pressureAltitude: [-1000, 15000],
  windSpeed: [0, 100],
  windDirection: [0, 360],
} as const

function sanitizePerf(p: Partial<PerfInput> | undefined): PerfInput {
  const d = defaultPerfInput()
  if (!p || typeof p !== 'object') return d
  const airportId =
    typeof p.airportId === 'string' && getAirport(p.airportId) ? p.airportId : d.airportId
  const airport = getAirport(airportId)!
  const runwayId =
    typeof p.runwayId === 'string' && getRunway(airport, p.runwayId) ? p.runwayId : d.runwayId
  const endIndex = p.endIndex === 0 || p.endIndex === 1 ? p.endIndex : d.endIndex
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback
  const surface: SurfaceState = p.surface === 'wet' || p.surface === 'dry' ? p.surface : d.surface
  return {
    airportId,
    runwayId,
    endIndex,
    temperature: num(p.temperature, ...PERF_BOUNDS.temperature, d.temperature),
    pressureAltitude: num(
      p.pressureAltitude,
      ...PERF_BOUNDS.pressureAltitude,
      d.pressureAltitude,
    ),
    windSpeed: num(p.windSpeed, ...PERF_BOUNDS.windSpeed, d.windSpeed),
    windDirection: num(p.windDirection, ...PERF_BOUNDS.windDirection, d.windDirection),
    surface,
  }
}

/** 持久化/迁移用的宽松输入（各字段与嵌套 perf 都允许缺失） */
export type SanitizableState = Partial<Omit<PlannerState, 'perf'>> & {
  perf?: Partial<PerfInput>
}

/** 从持久化数据（含旧版缺字段情况）消毒出合法方案 */
export function sanitizeState(parsed: SanitizableState | null | undefined): PlannerState {
  const base = createDefaultState()
  if (!parsed || typeof parsed !== 'object') return base

  const assignments: Record<string, string> = {}
  if (parsed.assignments && typeof parsed.assignments === 'object') {
    for (const [itemId, stationId] of Object.entries(parsed.assignments)) {
      if (typeof stationId !== 'string' || !isLegalPlacement(itemId, stationId)) continue
      // 座位唯一占用：后到的重复分配丢弃
      if (
        stations.get(stationId)!.kind === 'seat' &&
        Object.values(assignments).includes(stationId)
      ) {
        continue
      }
      assignments[itemId] = stationId
    }
  }

  const fuel: Record<string, number> = { ...base.fuel }
  if (parsed.fuel && typeof parsed.fuel === 'object') {
    for (const tank of aircraft.fuelTanks) {
      const v = (parsed.fuel as Record<string, unknown>)[tank.id]
      if (typeof v === 'number') fuel[tank.id] = clamp(Math.round(v), 0, tank.capacity)
    }
  }

  const burn =
    typeof parsed.burn === 'number' ? clamp(Math.round(parsed.burn), 0, totalCapacity) : base.burn

  return { assignments, fuel, burn, perf: sanitizePerf(parsed.perf) }
}

export function reducer(state: PlannerState, action: Action): PlannerState {
  switch (action.type) {
    case 'assign': {
      if (!isLegalPlacement(action.itemId, action.stationId)) return state
      const station = stations.get(action.stationId)!
      const next = { ...state.assignments }
      const prevStationId = next[action.itemId]
      if (station.kind === 'seat') {
        // 座位唯一占用：若目标座位已有人，交换（来源也是座位）或将其卸下
        const occupantId = Object.keys(next).find(
          (id) => id !== action.itemId && next[id] === action.stationId,
        )
        if (occupantId) {
          const prevStation = prevStationId ? stations.get(prevStationId) : undefined
          if (prevStation && prevStation.kind === 'seat') {
            next[occupantId] = prevStationId!
          } else {
            delete next[occupantId]
          }
        }
      }
      next[action.itemId] = action.stationId
      return { ...state, assignments: next }
    }
    case 'unassign': {
      if (!(action.itemId in state.assignments)) return state
      const next = { ...state.assignments }
      delete next[action.itemId]
      return { ...state, assignments: next }
    }
    case 'setFuel': {
      const tank = aircraft.fuelTanks.find((t) => t.id === action.tankId)
      if (!tank) return state
      return {
        ...state,
        fuel: { ...state.fuel, [action.tankId]: clamp(Math.round(action.value), 0, tank.capacity) },
      }
    }
    case 'setBurn':
      return { ...state, burn: clamp(Math.round(action.value), 0, totalCapacity) }
    case 'setPerf': {
      // 切跑道时若 endIndex 在新跑道仍合法则保留
      const merged = { ...state.perf, ...action.patch }
      return { ...state, perf: sanitizePerf(merged) }
    }
    case 'applyPlan':
      return sanitizeState(action.plan)
    case 'reset':
      return createDefaultState()
  }
}

// ---------- 撤销 / 重做 ----------

interface PastEntry {
  /** 变更前快照（undo 目标） */
  snapshot: PlannerState
  /** 合并键：与栈顶同键的连续变更只保留一个撤销点 */
  coalesceKey?: string
}

export interface HistoryState {
  present: PlannerState
  past: PastEntry[]
  /** redo 栈：未来状态快照（新动作清空） */
  future: PlannerState[]
}

export type HistoryAction = Action | { type: 'undo' } | { type: 'redo' }

export function createHistory(initial?: PlannerState): HistoryState {
  return { present: initial ?? createDefaultState(), past: [], future: [] }
}

export function canUndo(h: HistoryState): boolean {
  return h.past.length > 0
}
export function canRedo(h: HistoryState): boolean {
  return h.future.length > 0
}

/**
 * 带历史的 reducer：普通动作经纯 reducer 计算并按 coalesceKey 合并入撤销栈；
 * undo/redo 在 past/future 间移动快照。采用候选（applyPlan）是独立撤销点。
 */
export function historyReducer(h: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const last = h.past[h.past.length - 1]
    if (!last) return h
    return {
      present: last.snapshot,
      past: h.past.slice(0, -1),
      future: [h.present, ...h.future],
    }
  }
  if (action.type === 'redo') {
    const next = h.future[0]
    if (!next) return h
    return {
      present: next,
      past: [...h.past, { snapshot: h.present }],
      future: h.future.slice(1),
    }
  }

  const nextPresent = reducer(h.present, action)
  if (nextPresent === h.present) return h

  const coalesceKey =
    'coalesceKey' in action ? action.coalesceKey : undefined
  const top = h.past[h.past.length - 1]
  if (coalesceKey && top?.coalesceKey === coalesceKey) {
    // 同一连续输入：保留最初的变更前快照，不新增撤销点
    return { present: nextPresent, past: h.past, future: [] }
  }
  return {
    present: nextPresent,
    past: [...h.past, { snapshot: h.present, coalesceKey }],
    future: [],
  }
}

// ---------- 持久化（v1 → v2 迁移） ----------

const STORAGE_KEY = 'k12-loadsheet-v2'
const LEGACY_KEY = 'k12-loadsheet-v1'

interface PersistedV2 {
  version: 2
  present: SanitizableState
  past?: { snapshot: SanitizableState; coalesceKey?: string }[]
  future?: SanitizableState[]
}

/** 从 v2/v1 原始存储串解析历史；v2 缺失时从 v1 迁移；任何损坏回退初始航班 */
export function parseHistoryState(rawV2: string | null, rawV1: string | null): HistoryState {
  try {
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as PersistedV2
      if (parsed && parsed.version === 2 && parsed.present) {
        const present = sanitizeState(parsed.present)
        const past: PastEntry[] = Array.isArray(parsed.past)
          ? parsed.past
              .filter((e) => e && typeof e === 'object' && e.snapshot)
              .map((e) => ({ snapshot: sanitizeState(e.snapshot), coalesceKey: e.coalesceKey }))
          : []
        const future: PlannerState[] = Array.isArray(parsed.future)
          ? parsed.future.map((s) => sanitizeState(s))
          : []
        return { present, past, future }
      }
    }
    // v1 → v2 迁移：旧记录只有 assignments/fuel/burn，性能输入取默认（短湿跑道示例）
    if (rawV1) {
      const parsed = JSON.parse(rawV1) as Partial<PlannerState>
      return createHistory(sanitizeState(parsed))
    }
  } catch {
    // 数据损坏：回退初始航班
  }
  return createHistory()
}

/** 启动时恢复上次的方案与历史；v2 缺失时从 v1 迁移；任何损坏回退初始航班 */
export function loadHistory(): HistoryState {
  try {
    return parseHistoryState(localStorage.getItem(STORAGE_KEY), localStorage.getItem(LEGACY_KEY))
  } catch {
    return createHistory()
  }
}

export function saveHistory(h: HistoryState): void {
  try {
    const payload: PersistedV2 = {
      version: 2,
      present: h.present,
      past: h.past.map((e) => ({ snapshot: e.snapshot, coalesceKey: e.coalesceKey })),
      future: h.future,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 存储不可用时静默忽略（如隐私模式）
  }
}
