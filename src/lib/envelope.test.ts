import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { cgLimitsAt, envelopeViolation, isInsideEnvelope } from './envelope'

const env = aircraft.envelope

describe('包线插值', () => {
  it('包线节点处返回节点值', () => {
    expect(cgLimitsAt(env, 6200)).toEqual({ forward: 150, aft: 174 })
  })

  it('相邻节点之间线性插值', () => {
    // 4500 (151/173) 与 6200 (150/174) 的中点
    const limits = cgLimitsAt(env, 5350)
    expect(limits.forward).toBeCloseTo(150.5, 5)
    expect(limits.aft).toBeCloseTo(173.5, 5)
  })

  it('后限随重量增加而收紧（斜率正确）', () => {
    // 7500 (171.5) 与 8750 (168.5) 之间：每 1250 lb 收紧 3 in
    const limits = cgLimitsAt(env, 8125)
    expect(limits.aft).toBeCloseTo(170.0, 5)
  })

  it('超出包线重量范围时钳制到端点值', () => {
    expect(cgLimitsAt(env, 4000)).toEqual({ forward: 151, aft: 173 })
    expect(cgLimitsAt(env, 9999)).toEqual({ forward: 148, aft: 168.5 })
  })

  it('重心判定：越前限 / 越后限 / 包线内', () => {
    expect(envelopeViolation(env, 6200, 149)).toEqual({ side: 'forward', limit: 150 })
    expect(envelopeViolation(env, 6200, 175)).toEqual({ side: 'aft', limit: 174 })
    expect(envelopeViolation(env, 6200, 160)).toBeNull()
    expect(isInsideEnvelope(env, 6200, 160)).toBe(true)
  })

  it('边界值视为包线内', () => {
    expect(envelopeViolation(env, 6200, 150)).toBeNull()
    expect(envelopeViolation(env, 6200, 174)).toBeNull()
  })
})
