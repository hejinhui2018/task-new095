import { describe, expect, it } from 'vitest'
import {
  canRedo,
  canUndo,
  createDefaultState,
  createHistory,
  historyReducer,
  parseHistoryState,
  reducer,
  sanitizeState,
  type HistoryState,
} from './store'
import { defaultPerfInput } from '../lib/performance'

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

  it('reset 恢复初始航班（含默认跑道输入）', () => {
    const s0 = createDefaultState()
    const s1 = reducer(s0, { type: 'setBurn', value: 3000 })
    const s2 = reducer(s1, { type: 'unassign', itemId: 'pax02' })
    expect(reducer(s2, { type: 'reset' })).toEqual(s0)
  })
})

describe('跑道性能输入', () => {
  it('默认状态包含短湿跑道示例', () => {
    const s0 = createDefaultState()
    expect(s0.perf).toEqual(defaultPerfInput())
    expect(s0.perf.runwayId).toBe('rwy09')
    expect(s0.perf.surface).toBe('wet')
  })

  it('setPerf 局部更新温度/风/道面', () => {
    const s0 = createDefaultState()
    const s1 = reducer(s0, { type: 'setPerf', patch: { temperature: 35 } })
    expect(s1.perf.temperature).toBe(35)
    expect(s1.perf.runwayId).toBe('rwy09')
    const s2 = reducer(s1, { type: 'setPerf', patch: { surface: 'dry' } })
    expect(s2.perf.surface).toBe('dry')
  })

  it('切换跑道与使用方向', () => {
    const s0 = createDefaultState()
    const s1 = reducer(s0, { type: 'setPerf', patch: { runwayId: 'rwy15', endIndex: 1 } })
    expect(s1.perf.runwayId).toBe('rwy15')
    expect(s1.perf.endIndex).toBe(1)
  })

  it('非法跑道/机场回退默认，数值输入钳制但不阻挡表外气象（由放行层拒绝）', () => {
    const s0 = createDefaultState()
    expect(reducer(s0, { type: 'setPerf', patch: { runwayId: 'rwyXX' } }).perf.runwayId).toBe('rwy09')
    expect(reducer(s0, { type: 'setPerf', patch: { windSpeed: 999 } }).perf.windSpeed).toBe(100)
    // 气压高度 6500 在 sanity 界内（虽超出性能表 6000 覆盖，交由放行层明确拒绝，不在这里夹掉）
    expect(reducer(s0, { type: 'setPerf', patch: { pressureAltitude: 6500 } }).perf.pressureAltitude).toBe(6500)
  })
})

describe('撤销 / 重做', () => {
  const fire = (h: HistoryState, a: Parameters<typeof historyReducer>[1]) => historyReducer(h, a)

  it('普通动作入栈，可逐步 undo / redo', () => {
    let h = createHistory()
    h = fire(h, { type: 'setBurn', value: 2000 })
    h = fire(h, { type: 'unassign', itemId: 'pax01' })
    expect(canUndo(h)).toBe(true)
    expect(canRedo(h)).toBe(false)
    h = fire(h, { type: 'undo' })
    expect(h.present.assignments.pax01).toBe('1A') // 撤销卸下
    h = fire(h, { type: 'undo' })
    expect(h.present.burn).toBe(1100) // 撤销耗油修改（默认 burn）
    expect(canRedo(h)).toBe(true)
    h = fire(h, { type: 'redo' })
    expect(h.present.burn).toBe(2000)
  })

  it('相同 coalesceKey 的连续动作合并为一个撤销点（滑块拖动）', () => {
    let h = createHistory()
    h = fire(h, { type: 'setFuel', tankId: 'aux', value: 600, coalesceKey: 'fuel' })
    h = fire(h, { type: 'setFuel', tankId: 'aux', value: 700, coalesceKey: 'fuel' })
    h = fire(h, { type: 'setFuel', tankId: 'aux', value: 800, coalesceKey: 'fuel' })
    expect(h.past).toHaveLength(1)
    expect(h.present.fuel.aux).toBe(800)
    h = fire(h, { type: 'undo' })
    expect(h.present.fuel.aux).toBe(500) // 一次回到拖动前
  })

  it('不同 coalesceKey（fuel vs perf）不合并；新动作清空 redo 栈', () => {
    let h = createHistory()
    h = fire(h, { type: 'setFuel', tankId: 'aux', value: 800, coalesceKey: 'fuel' })
    h = fire(h, { type: 'setPerf', patch: { temperature: 33 }, coalesceKey: 'perf' })
    expect(h.past).toHaveLength(2)
    h = fire(h, { type: 'undo' })
    expect(canRedo(h)).toBe(true)
    h = fire(h, { type: 'setBurn', value: 1500 }) // 新动作清空 redo
    expect(canRedo(h)).toBe(false)
    expect(h.present.burn).toBe(1500)
  })

  it('无状态变化的动作不产生历史点', () => {
    let h = createHistory()
    h = fire(h, { type: 'assign', itemId: 'bag01', stationId: '3D' }) // 非法放置
    expect(h.past).toHaveLength(0)
    expect(canUndo(h)).toBe(false)
  })

  it('空栈 undo/redo 安全返回', () => {
    const h = createHistory()
    expect(historyReducer(h, { type: 'undo' })).toBe(h)
    expect(historyReducer(h, { type: 'redo' })).toBe(h)
  })

  it('应用候选（applyPlan）是独立撤销点，undo 可回到应用前', () => {
    let h = createHistory()
    h = fire(h, { type: 'setBurn', value: 2000, coalesceKey: 'burn' })
    const candidate = {
      ...h.present,
      fuel: { aux: 500, main: 980 },
    }
    h = fire(h, { type: 'applyPlan', plan: candidate })
    expect(h.present.fuel.main).toBe(980)
    h = fire(h, { type: 'undo' })
    expect(h.present.fuel.main).toBe(1450)
    expect(h.present.burn).toBe(2000)
  })
})

describe('持久化迁移（v1 → v2）与消毒', () => {
  it('v1 记录（无 perf）迁移后补入默认跑道输入，配载数据保留', () => {
    const v1 = JSON.stringify({
      assignments: { pax01: '3D' },
      fuel: { aux: 100, main: 200 },
      burn: 300,
    })
    const h = parseHistoryState(null, v1)
    expect(h.present.assignments.pax01).toBe('3D')
    expect(h.present.fuel.aux).toBe(100)
    expect(h.present.burn).toBe(300)
    expect(h.present.perf).toEqual(defaultPerfInput())
    expect(h.past).toHaveLength(0) // 迁移不携带历史
  })

  it('v2 记录恢复 present 与 past/future，可继续 undo', () => {
    const v2 = JSON.stringify({
      version: 2,
      present: { ...createDefaultState(), burn: 2000 },
      past: [{ snapshot: { ...createDefaultState() } }],
      future: [],
    })
    const h = parseHistoryState(v2, null)
    expect(h.present.burn).toBe(2000)
    expect(canUndo(h)).toBe(true)
    const undone = historyReducer(h, { type: 'undo' })
    expect(undone.present.burn).toBe(1100)
  })

  it('损坏 JSON / 错误版本 / 非法配载回退或丢弃，不抛异常', () => {
    expect(parseHistoryState('{not json', null).present).toEqual(createDefaultState())
    const wrongVersion = JSON.stringify({ version: 1, present: {} })
    expect(parseHistoryState(wrongVersion, null).present).toEqual(createDefaultState())
    // 非法座位占用被丢弃
    const h = parseHistoryState(
      JSON.stringify({
        version: 2,
        present: { assignments: { bag01: '1A', pax01: '1A' }, fuel: {}, burn: 999999 },
      }),
      null,
    )
    expect(h.present.assignments.bag01).toBeUndefined()
    expect(h.present.burn).toBe(3100)
    expect(h.present.perf).toEqual(defaultPerfInput())
  })

  it('sanitizeState 对缺字段与越界值健壮', () => {
    const s = sanitizeState({ fuel: { aux: -50, main: 99999 }, perf: { temperature: 200 } })
    expect(s.fuel.aux).toBe(0)
    expect(s.fuel.main).toBe(2200)
    expect(s.perf.temperature).toBe(60) // sanity 上界
  })
})
