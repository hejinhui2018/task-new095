/**
 * 性能表严格多维插值。
 *
 * 关键规则（放行安全要求）：
 * - 查询坐标必须落在表格轴覆盖范围内（含边界），超出一律返回 OUT_OF_RANGE，
 *   绝不外推、也不夹到端点伪装成有效值；
 * - 插值盒角点若含 null（该组合无审定数据），盒内查询一律返回 NO_TABLE_DATA，
 *   不跨空洞插值；
 * - 重量反解（求满足限制的最大重量）只在重量轴节点间线性内插，
 *   在最小节点仍不满足 → NO_FEASIBLE_WEIGHT；在最大节点仍满足 → 该阶段不构成限制。
 */
import type { PerformanceTable } from './performanceData'

export type AxisName = 'altitude' | 'temperature' | 'weight'

export type LookupErrorCode =
  | 'OUT_OF_RANGE'
  | 'NO_TABLE_DATA'
  | 'NO_FEASIBLE_WEIGHT'
  | 'NOT_MONOTONIC'

export interface LookupError {
  code: LookupErrorCode
  /** OUT_OF_RANGE 时指明越界的轴与边界 */
  axis?: AxisName
  value?: number
  min?: number
  max?: number
  message: string
}

export type LookupResult<T> = { ok: true; value: T } | { ok: false; error: LookupError }

interface Segment {
  i0: number
  i1: number
  /** i0 → i1 的插值比例 [0,1] */
  t: number
}

/** 在严格升序轴上定位包裹区间；等于节点时退化为单点；超出范围返回错误 */
function findSegment(axis: number[], value: number, name: AxisName): Segment | LookupError {
  if (!Number.isFinite(value)) {
    return { code: 'OUT_OF_RANGE', axis: name, value, message: `${name} 输入不是有限数值` }
  }
  const min = axis[0]
  const max = axis[axis.length - 1]
  if (value < min || value > max) {
    return {
      code: 'OUT_OF_RANGE',
      axis: name,
      value,
      min,
      max,
      message: `${name}=${value} 超出性能表覆盖范围 [${min}, ${max}]，拒绝外推`,
    }
  }
  for (let i = 0; i < axis.length - 1; i++) {
    if (value >= axis[i] && value <= axis[i + 1]) {
      const span = axis[i + 1] - axis[i]
      return { i0: i, i1: i + 1, t: span === 0 ? 0 : (value - axis[i]) / span }
    }
  }
  // value 恰等于最大节点
  return { i0: axis.length - 1, i1: axis.length - 1, t: 0 }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** 取盒角点；null / 缺失视为无审定数据 */
function corner(
  table: PerformanceTable,
  ai: number,
  ti: number,
  wi: number,
): LookupResult<number> {
  const v = table.values[ai]?.[ti]?.[wi]
  if (v === undefined || v === null) {
    return {
      ok: false,
      error: {
        code: 'NO_TABLE_DATA',
        message: `性能表在 高度=${table.altitudes[ai]}ft、温度=${table.temperatures[ti]}°C、重量=${table.weights[wi]}lb 处无审定数据`,
      },
    }
  }
  return { ok: true, value: v }
}

/**
 * 三线性插值（气压高度 × 气温 × 重量）。
 * 坐标恰好落在轴节点/面上时退化为低维插值；超界或插值盒含空洞时拒绝。
 */
export function interpolate3(
  table: PerformanceTable,
  altitude: number,
  temperature: number,
  weight: number,
): LookupResult<number> {
  const a = findSegment(table.altitudes, altitude, 'altitude')
  if ('code' in a) return { ok: false, error: a }
  const t = findSegment(table.temperatures, temperature, 'temperature')
  if ('code' in t) return { ok: false, error: t }
  const w = findSegment(table.weights, weight, 'weight')
  if ('code' in w) return { ok: false, error: w }

  // vals 顺序：ai(0/1) × ti(0/1) × wi(0/1)
  const vals: number[] = []
  for (const ai of [a.i0, a.i1]) {
    for (const ti of [t.i0, t.i1]) {
      for (const wi of [w.i0, w.i1]) {
        const c = corner(table, ai, ti, wi)
        if (!c.ok) return c
        vals.push(c.value)
      }
    }
  }
  const at = (ai: 0 | 1, ti: 0 | 1, wi: 0 | 1) => vals[ai * 4 + ti * 2 + wi]
  const c00 = lerp(at(0, 0, 0), at(0, 0, 1), w.t)
  const c01 = lerp(at(0, 1, 0), at(0, 1, 1), w.t)
  const c10 = lerp(at(1, 0, 0), at(1, 0, 1), w.t)
  const c11 = lerp(at(1, 1, 0), at(1, 1, 1), w.t)
  const c0 = lerp(c00, c01, t.t)
  const c1 = lerp(c10, c11, t.t)
  return { ok: true, value: lerp(c0, c1, a.t) }
}

export interface InvertedLimit {
  /**
   * 满足限制的最大重量。
   * bounded=false 表示在性能表最大重量节点处仍满足限制——该阶段在审定重量范围内不构成限制。
   */
  weight: number
  bounded: boolean
}

/**
 * 沿重量轴精确反解临界重量：
 * - distance 模式：所需距离随重量递增，求 value(w) ≤ limit 的最大重量；
 * - gradient 模式：可用梯度随重量递减，求 value(w) ≥ limit 的最大重量。
 *
 * 在给定（高度、温度）处先对每个重量节点双线性插值；任一节点插值盒含空洞即拒绝；
 * 最小重量节点仍不满足 → NO_FEASIBLE_WEIGHT；最大节点仍满足 → bounded:false。
 */
export function invertWeightAtLimit(
  table: PerformanceTable,
  altitude: number,
  temperature: number,
  limit: number,
  mode: 'distance' | 'gradient',
): LookupResult<InvertedLimit> {
  const a = findSegment(table.altitudes, altitude, 'altitude')
  if ('code' in a) return { ok: false, error: a }
  const t = findSegment(table.temperatures, temperature, 'temperature')
  if ('code' in t) return { ok: false, error: t }

  const weights = table.weights
  const values: number[] = []
  for (let wi = 0; wi < weights.length; wi++) {
    const picks: number[] = []
    for (const ai of [a.i0, a.i1]) {
      for (const ti of [t.i0, t.i1]) {
        const c = corner(table, ai, ti, wi)
        if (!c.ok) return c
        picks.push(c.value)
      }
    }
    // 顺序：(i0,i0),(i0,i1),(i1,i0),(i1,i1)
    const at2 = (ai: 0 | 1, ti: 0 | 1) => picks[ai * 2 + ti]
    const lo = lerp(at2(0, 0), at2(0, 1), t.t)
    const hi = lerp(at2(1, 0), at2(1, 1), t.t)
    values.push(lerp(lo, hi, a.t))
  }

  const passes = (v: number) => (mode === 'distance' ? v <= limit : v >= limit)
  if (!Number.isFinite(limit) || !passes(values[0])) {
    return {
      ok: false,
      error: {
        code: 'NO_FEASIBLE_WEIGHT',
        message: `即使在表列最小重量 ${weights[0]} lb 仍不满足该阶段限制（临界值 ${limit}），无可用限重`,
      },
    }
  }
  if (passes(values[values.length - 1])) {
    return { ok: true, value: { weight: weights[weights.length - 1], bounded: false } }
  }
  for (let i = 0; i < values.length - 1; i++) {
    if (passes(values[i]) && !passes(values[i + 1])) {
      const span = values[i + 1] - values[i]
      if (Math.abs(span) < 1e-12) return { ok: true, value: { weight: weights[i], bounded: true } }
      // distance：fraction of interval where value reaches limit
      // gradient：values 递减，交点比例 = 1 - (limit-v0)/(v1-v0)
      const f = (limit - values[i]) / span
      const tt = mode === 'distance' ? f : 1 - f
      return {
        ok: true,
        value: { weight: weights[i] + tt * (weights[i + 1] - weights[i]), bounded: true },
      }
    }
  }
  return {
    ok: false,
    error: { code: 'NOT_MONOTONIC', message: '性能表沿重量轴不满足单调性假设' },
  }
}
