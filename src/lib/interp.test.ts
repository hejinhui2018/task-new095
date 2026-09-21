import { describe, expect, it } from 'vitest'
import { k12Performance } from './performanceData'
import { interpolate3, invertWeightAtLimit } from './interp'

const ground = k12Performance.tables.groundRun
const oneEngine = k12Performance.tables.climbOneEngine

describe('性能表严格插值', () => {
  it('表节点处返回表值（不做改动）', () => {
    const r = interpolate3(ground, 0, -10, 5500)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(ground.values[0][0][0])
  })

  it('高度/温度/重量三轴中点线性插值', () => {
    // (0,-10,5500) 与 (2000,-10,5500) 中点
    const a = interpolate3(ground, 0, -10, 5500)
    const b = interpolate3(ground, 2000, -10, 5500)
    const mid = interpolate3(ground, 1000, -10, 5500)
    expect(a.ok && b.ok && mid.ok).toBe(true)
    if (a.ok && b.ok && mid.ok) {
      expect(mid.value).toBeCloseTo((a.value + b.value) / 2, 6)
    }
  })

  it('温度轴插值正确', () => {
    const a = interpolate3(ground, 2000, -10, 6500)
    const b = interpolate3(ground, 2000, 10, 6500)
    const mid = interpolate3(ground, 2000, 0, 6500)
    expect(a.ok && b.ok && mid.ok).toBe(true)
    if (a.ok && b.ok && mid.ok) {
      expect(mid.value).toBeCloseTo((a.value + b.value) / 2, 6)
    }
  })

  it('超出高度轴范围：拒绝而非外推或夹值', () => {
    const lo = interpolate3(ground, -1, 10, 7000)
    const hi = interpolate3(ground, 6001, 10, 7000)
    expect(lo.ok).toBe(false)
    expect(hi.ok).toBe(false)
    if (!lo.ok) {
      expect(lo.error.code).toBe('OUT_OF_RANGE')
      expect(lo.error.axis).toBe('altitude')
    }
    if (!hi.ok) expect(hi.error.code).toBe('OUT_OF_RANGE')
  })

  it('超出温度轴范围：拒绝（含边界外极小量）', () => {
    const r = interpolate3(ground, 2000, 40.5, 7000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('OUT_OF_RANGE')
      expect(r.error.axis).toBe('temperature')
    }
    // 恰好等于上界允许
    expect(interpolate3(ground, 2000, 40, 7000).ok).toBe(true)
  })

  it('超出重量轴范围：拒绝而非夹到边界', () => {
    const r = interpolate3(ground, 2000, 10, 8800)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.axis).toBe('weight')
  })

  it('插值盒含无数据角点（8750lb/4000ft+/40°C）：拒绝 NO_TABLE_DATA', () => {
    const r = interpolate3(ground, 4000, 40, 8700)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('NO_TABLE_DATA')
  })

  it('空洞旁边的有效盒仍可插值（不跨空洞）', () => {
    // 8000 lb 在同一气候条件下四个角点都有数据
    const r = interpolate3(ground, 4000, 40, 8000)
    expect(r.ok).toBe(true)
  })

  it('距离反解：限重随可用距离减小而减小，且再查表值≈当量距离', () => {
    // 2000ft/20°C 下 8750lb 需 2665ft：3000 不受表约束，2500 受限
    const hi = invertWeightAtLimit(ground, 2000, 20, 3000, 'distance')
    const lo = invertWeightAtLimit(ground, 2000, 20, 2500, 'distance')
    expect(hi.ok && lo.ok).toBe(true)
    if (hi.ok && lo.ok) {
      expect(lo.value.weight).toBeLessThan(hi.value.weight)
      expect(lo.value.bounded).toBe(true)
      const back = interpolate3(ground, 2000, 20, lo.value.weight)
      expect(back.ok).toBe(true)
      if (back.ok) expect(back.value).toBeCloseTo(2500, 4)
    }
  })

  it('距离反解：最小重量仍不够 → NO_FEASIBLE_WEIGHT', () => {
    const r = invertWeightAtLimit(ground, 2000, 20, 500, 'distance')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('NO_FEASIBLE_WEIGHT')
  })

  it('距离反解：最大重量仍满足 → bounded=false（不受表约束）', () => {
    const r = invertWeightAtLimit(ground, 0, -10, 99999, 'distance')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.bounded).toBe(false)
  })

  it('梯度反解：所需梯度越高限重越低', () => {
    // 2000ft/20°C 单发梯度：5500→2.06%、6500→1.95%、7500→1.84%、8500→1.73%
    const easy = invertWeightAtLimit(oneEngine, 2000, 20, 1.3, 'gradient')
    const hard = invertWeightAtLimit(oneEngine, 2000, 20, 1.85, 'gradient')
    expect(easy.ok && hard.ok).toBe(true)
    if (easy.ok && hard.ok) {
      expect(hard.value.weight).toBeLessThan(easy.value.weight)
      // 1.95%(6500) ≥ 1.85 > 1.84%(7500)，交点落在 6500~7500 之间
      expect(hard.value.weight).toBeGreaterThan(6500)
      expect(hard.value.weight).toBeLessThan(7500)
    }
  })

  it('梯度反解：最小重量梯度仍不足 → NO_FEASIBLE_WEIGHT', () => {
    // 2000ft/20°C 最小重量（5500lb）梯度为 2.06%
    const r = invertWeightAtLimit(oneEngine, 2000, 20, 2.2, 'gradient')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('NO_FEASIBLE_WEIGHT')
  })

  it('单发表高×热×重空洞：该条件反解拒绝 NO_TABLE_DATA', () => {
    // 4000ft、40°C 时 7500/8500/8750 节点无数据
    const r = invertWeightAtLimit(oneEngine, 4000, 40, 0.5, 'gradient')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('NO_TABLE_DATA')
  })
})
