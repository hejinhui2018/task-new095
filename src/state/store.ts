import { aircraft } from '../lib/aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from '../lib/manifest'
import { buildStationMap } from '../lib/weightBalance'

/** 配载方案状态（会被持久化到 localStorage） */
export interface PlannerState {
  /** itemId -> 站位 id（座位号或行李舱 id）；缺失表示未装载 */
  assignments: Record<string, string>
  /** tankId -> 载油量 lb */
  fuel: Record<string, number>
  /** 预计航程耗油 lb */
  burn: number
}

export type Action =
  | { type: 'assign'; itemId: string; stationId: string }
  | { type: 'unassign'; itemId: string }
  | { type: 'setFuel'; tankId: string; value: number }
  | { type: 'setBurn'; value: number }
  | { type: 'reset' }

const stations = buildStationMap(aircraft)
const itemsById = new Map(manifestItems.map((i) => [i.id, i]))
const totalCapacity = aircraft.fuelTanks.reduce((s, t) => s + t.capacity, 0)

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)

export function createDefaultState(): PlannerState {
  return { assignments: { ...defaultAssignments }, fuel: { ...defaultFuel }, burn: defaultBurn }
}

/** 校验一次分配是否合法：乘客只能坐座位，行李只能进行李舱 */
function isLegalPlacement(itemId: string, stationId: string): boolean {
  const item = itemsById.get(itemId)
  const station = stations.get(stationId)
  if (!item || !station) return false
  if (station.kind === 'seat') return item.kind === 'pax'
  return item.kind === 'bag'
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
    case 'reset':
      return createDefaultState()
  }
}

const STORAGE_KEY = 'k12-loadsheet-v1'

/** 把未知 JSON 输入校验/钳制为合法的配载状态；非法字段回退默认值（供持久化恢复与版本迁移复用） */
export function coercePlannerState(parsed: unknown): PlannerState {
  const base = createDefaultState()
  if (!parsed || typeof parsed !== 'object') return base
  const p = parsed as Partial<PlannerState>

  const assignments: Record<string, string> = {}
  if (p.assignments && typeof p.assignments === 'object') {
    for (const [itemId, stationId] of Object.entries(p.assignments)) {
      if (!isLegalPlacement(itemId, stationId)) continue
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
  if (p.fuel && typeof p.fuel === 'object') {
    for (const tank of aircraft.fuelTanks) {
      const v = p.fuel[tank.id]
      if (typeof v === 'number') fuel[tank.id] = clamp(Math.round(v), 0, tank.capacity)
    }
  }

  const burn =
    typeof p.burn === 'number' ? clamp(Math.round(p.burn), 0, totalCapacity) : base.burn
  return { assignments, fuel, burn }
}

/** 启动时恢复上次的方案；数据缺失或非法时回退到初始航班 */
export function loadState(): PlannerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createDefaultState()
    return coercePlannerState(JSON.parse(raw))
  } catch {
    return createDefaultState()
  }
}

export function saveState(state: PlannerState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时静默忽略（如隐私模式）
  }
}
