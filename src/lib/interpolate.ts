/**
 * 严格线性插值工具：超出表格范围一律拒绝（返回 null），绝不外推或夹到边界。
 * 性能表按 (气压高度, 温度) 两个维度索引，表内数据为「该条件下允许的最大重量」。
 */

export interface Axis {
  /** 节点坐标（温度 °C 或气压高度 ft），必须严格递增 */
  nodes: number[]
  name: string
}

export interface Grid2D {
  x: Axis
  y: Axis
  /**
   * 长度 = x.nodes.length * y.nodes.length；
   * data[ix * y.nodes.length + iy] 为 (x.nodes[ix], y.nodes[iy]) 处的值。
   * null 表示该节点无数据（如超出越障/构型适用范围）。
   */
  data: (number | null)[]
}

export type OutCode =
  | 'empty'
  | 'below-min'
  | 'above-max'
  | 'null-cell'
  | 'invalid'

export interface OutOfRange {
  code: OutCode
  axis?: string
  /** 越界端的边界值（夹到边界伪装有效是被禁止的，这里只用于提示） */
  bound?: number
  actual?: number
}

export type InterpResult = { ok: true; value: number } | { ok: false; reason: OutOfRange }

const ixAt = (g: Grid2D, ix: number, iy: number): number | null =>
  g.data[ix * g.y.nodes.length + iy] ?? null

/**
 * 双线性插值。任一包围节点为 null（无数据）则拒绝；
 * 查询坐标超出任一轴标注范围则拒绝，绝不外推；恰在节点上时返回节点值。
 */
export function bilinearStrict(g: Grid2D, xv: number, yv: number): InterpResult {
  const nx = g.x.nodes.length
  const ny = g.y.nodes.length
  if (nx === 0 || ny === 0 || g.data.length !== nx * ny) {
    return { ok: false, reason: { code: 'empty' } }
  }
  if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
    return { ok: false, reason: { code: 'invalid' } }
  }
  const locate = (axis: Axis, v: number): OutOfRange | { i0: number; i1: number; t: number } => {
    const n = axis.nodes
    if (v < n[0]) return { code: 'below-min', axis: axis.name, bound: n[0], actual: v }
    if (v > n[n.length - 1]) return { code: 'above-max', axis: axis.name, bound: n[n.length - 1], actual: v }
    let i = 0
    while (i < n.length - 1 && v > n[i + 1]) i++
    if (v === n[i]) return { i0: i, i1: i, t: 0 }
    if (i === n.length - 1) return { i0: i, i1: i, t: 0 }
    return { i0: i, i1: i + 1, t: (v - n[i]) / (n[i + 1] - n[i]) }
  }

  const lx = locate(g.x, xv)
  if ('code' in lx) return { ok: false, reason: lx }
  const ly = locate(g.y, yv)
  if ('code' in ly) return { ok: false, reason: ly }

  // 精确落在节点上时 i0 === i1，索引自然重合，无需特判
  const v00 = ixAt(g, lx.i0, ly.i0)
  const v01 = ixAt(g, lx.i0, ly.i1)
  const v10 = ixAt(g, lx.i1, ly.i0)
  const v11 = ixAt(g, lx.i1, ly.i1)
  if (v00 === null || v01 === null || v10 === null || v11 === null) {
    return { ok: false, reason: { code: 'null-cell' } }
  }
  const a = v00 + (v10 - v00) * lx.t
  const b = v01 + (v11 - v01) * lx.t
  return { ok: true, value: a + (b - a) * ly.t }
}

/** 一维严格线性插值；超出范围或相邻节点为 null 时拒绝 */
export function linearStrict(nodes: number[], values: (number | null)[], v: number): InterpResult {
  if (nodes.length === 0 || nodes.length !== values.length) {
    return { ok: false, reason: { code: 'empty' } }
  }
  if (!Number.isFinite(v)) return { ok: false, reason: { code: 'invalid' } }
  if (v < nodes[0]) return { ok: false, reason: { code: 'below-min', bound: nodes[0], actual: v } }
  if (v > nodes[nodes.length - 1])
    return { ok: false, reason: { code: 'above-max', bound: nodes[nodes.length - 1], actual: v } }
  let i = 0
  while (i < nodes.length - 1 && v > nodes[i + 1]) i++
  if (v === nodes[i] || i === nodes.length - 1) {
    const val = values[i]
    return val === null ? { ok: false, reason: { code: 'null-cell' } } : { ok: true, value: val }
  }
  const a = values[i]
  const b = values[i + 1]
  if (a === null || b === null) return { ok: false, reason: { code: 'null-cell' } }
  const t = (v - nodes[i]) / (nodes[i + 1] - nodes[i])
  return { ok: true, value: a + (b - a) * t }
}
