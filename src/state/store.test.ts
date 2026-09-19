import { describe, expect, it } from 'vitest'
import { createDefaultState, reducer } from './store'

describe('配载状态管理', () => {
  it('乘客可放到空座位，卸下后不再占位', () => {
    const s0 = createDefaultState()
    const s1 = reducer(s0, { type: 'unassign', itemId: 'pax01' })
    expect(s1.assignments.pax01).toBeUndefined()
    const s2 = reducer(s1, { type: 'assign', itemId: 'pax01', stationId: '3D' })
    expect(s2.assignments.pax01).toBe('3D')
  })

  it('乘客放到已占座位时与原乘客交换', () => {
    const s0 = createDefaultState() // pax01 在 1A，pax04 在 2A
    const s1 = reducer(s0, { type: 'assign', itemId: 'pax01', stationId: '2A' })
    expect(s1.assignments.pax01).toBe('2A')
    expect(s1.assignments.pax04).toBe('1A')
  })

  it('行李不能放座位，乘客不能进行李舱', () => {
    const s0 = createDefaultState()
    expect(reducer(s0, { type: 'assign', itemId: 'bag01', stationId: '3D' })).toBe(s0)
    expect(reducer(s0, { type: 'assign', itemId: 'pax01', stationId: 'bagFwd' })).toBe(s0)
  })

  it('加油量钳制在 [0, 油箱容量]', () => {
    const s0 = createDefaultState()
    expect(reducer(s0, { type: 'setFuel', tankId: 'aux', value: 99999 }).fuel.aux).toBe(900)
    expect(reducer(s0, { type: 'setFuel', tankId: 'aux', value: -5 }).fuel.aux).toBe(0)
  })

  it('预计耗油钳制在 [0, 总容量]', () => {
    const s0 = createDefaultState()
    expect(reducer(s0, { type: 'setBurn', value: 99999 }).burn).toBe(3100)
    expect(reducer(s0, { type: 'setBurn', value: -1 }).burn).toBe(0)
  })

  it('reset 恢复初始航班', () => {
    const s0 = createDefaultState()
    const s1 = reducer(s0, { type: 'setBurn', value: 3000 })
    const s2 = reducer(s1, { type: 'unassign', itemId: 'pax02' })
    expect(reducer(s2, { type: 'reset' })).toEqual(s0)
  })
})
