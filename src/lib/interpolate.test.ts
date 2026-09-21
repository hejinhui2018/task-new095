import { describe, expect, it } from 'vitest'
import { bilinearStrict, linearStrict, type Grid2D } from './interpolate'

/** 2×3 网格：value = 1000*x + y*10（x: 0,10；y: 0,1,2），便于手算 */
const grid: Grid2D = {
  x: { name: 'x', nodes: [0, 10] },
  y: { name: 'y', nodes: [0, 1, 2] },
  data: [
    0, 10, 20, // x=0
    10000, 10010, 10020, // x=10
  ],
}

describe('双线性严格插值', () => {
  it('节点上返回节点精确值', () => {
    expect(bilinearStrict(grid, 0, 0)).toEqual({ ok: true, value: 0 })
    expect(bilinearStrict(grid, 10, 2)).toEqual({ ok: true, value: 10020 })
    expect(bilinearStrict(grid, 0, 1)).toEqual({ ok: true, value: 10 })
  })

  it('单元格中心为四角平均', () => {
    // (x=5, y=0.5) 位于单元格 (0,10)×(0,1) 中心
    const r = bilinearStrict(grid, 5, 0.5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeCloseTo((0 + 10 + 10000 + 10010) / 4, 8)
  })

  it('沿轴插值正确', () => {
    const r = bilinearStrict(grid, 0, 0.5)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeCloseTo(5, 8)
    const r2 = bilinearStrict(grid, 5, 0)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value).toBeCloseTo(5000, 8)
  })

  it('超出 x 轴范围明确拒绝，给出越界端边界', () => {
    const lo = bilinearStrict(grid, -1, 1)
    expect(lo).toMatchObject({ ok: false, reason: { code: 'below-min', axis: 'x', bound: 0, actual: -1 } })
    const hi = bilinearStrict(grid, 11, 1)
    expect(hi).toMatchObject({ ok: false, reason: { code: 'above-max', axis: 'x', bound: 10 } })
  })

  it('超出 y 轴范围明确拒绝', () => {
    expect(bilinearStrict(grid, 5, -0.001)).toMatchObject({
      ok: false,
      reason: { code: 'below-min', axis: 'y' },
    })
    expect(bilinearStrict(grid, 5, 2.5)).toMatchObject({
      ok: false,
      reason: { code: 'above-max', axis: 'y' },
    })
  })

  it('边界值本身有效（不拒绝、不外推）', () => {
    expect(bilinearStrict(grid, 0, 2)).toEqual({ ok: true, value: 20 })
    expect(bilinearStrict(grid, 10, 0)).toEqual({ ok: true, value: 10000 })
  })

  it('包围节点含 null（无数据）时拒绝，不夹到边界', () => {
    const g: Grid2D = {
      x: { name: 'x', nodes: [0, 10] },
      y: { name: 'y', nodes: [0, 10] },
      data: [8000, null, 8500, 8600],
    }
    // 单元格内插值需要 null 角点 → 拒绝
    expect(bilinearStrict(g, 5, 5)).toEqual({ ok: false, reason: { code: 'null-cell' } })
    // 完全不依赖 null 角点的节点仍可取
    expect(bilinearStrict(g, 0, 0)).toEqual({ ok: true, value: 8000 })
    // 边上插值（x=0 边两节点 8000 与 null）→ 拒绝
    expect(bilinearStrict(g, 0, 5)).toEqual({ ok: false, reason: { code: 'null-cell' } })
  })

  it('非法输入（NaN/空表）拒绝', () => {
    expect(bilinearStrict(grid, NaN, 1).ok).toBe(false)
    expect(bilinearStrict({ x: { name: 'x', nodes: [] }, y: { name: 'y', nodes: [] }, data: [] }, 0, 0).ok).toBe(false)
  })
})

describe('一维严格插值', () => {
  it('节点与区间插值', () => {
    expect(linearStrict([0, 10], [100, 200], 5)).toEqual({ ok: true, value: 150 })
    expect(linearStrict([0, 10], [100, 200], 10)).toEqual({ ok: true, value: 200 })
  })
  it('超界拒绝不外推', () => {
    expect(linearStrict([0, 10], [100, 200], -1)).toMatchObject({ ok: false, reason: { code: 'below-min' } })
    expect(linearStrict([0, 10], [100, 200], 10.1)).toMatchObject({ ok: false, reason: { code: 'above-max' } })
  })
  it('相邻节点为 null 时拒绝', () => {
    expect(linearStrict([0, 5, 10], [100, null, 300], 5)).toEqual({ ok: false, reason: { code: 'null-cell' } })
    expect(linearStrict([0, 5, 10], [100, null, 300], 2)).toEqual({ ok: false, reason: { code: 'null-cell' } })
  })
})
