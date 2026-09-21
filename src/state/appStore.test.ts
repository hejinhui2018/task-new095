import { describe, expect, it } from 'vitest'
import {
  appReducer,
  coerceAppState,
  createDefaultAppState,
  createDefaultPerf,
  loadHistory,
  migrateV1ToV2,
  saveAppState,
  STORAGE_KEY_V1,
  STORAGE_KEY_V2,
  type AppState,
  type History,
} from './appStore'

const fresh = (): History => ({ past: [], present: createDefaultAppState(), future: [] })

describe('应用状态与撤销重做', () => {
  it('配载变更进入历史，可撤销重做', () => {
    let h = fresh()
    h = appReducer(h, { type: 'setBurn', value: 2000 })
    expect(h.present.plan.burn).toBe(2000)
    expect(h.past).toHaveLength(1)
    h = appReducer(h, { type: 'undo' })
    expect(h.present.plan.burn).toBe(1100)
    expect(h.future).toHaveLength(1)
    h = appReducer(h, { type: 'redo' })
    expect(h.present.plan.burn).toBe(2000)
  })

  it('无历史时撤销/重做无副作用', () => {
    const h = fresh()
    expect(appReducer(h, { type: 'undo' })).toBe(h)
    expect(appReducer(h, { type: 'redo' })).toBe(h)
  })

  it('同一 coalesceKey 的连续输入合并为一条历史', () => {
    let h = fresh()
    h = appReducer(h, { type: 'setFuel', tankId: 'main', value: 1500, coalesceKey: 'fuel-main' })
    h = appReducer(h, { type: 'setFuel', tankId: 'main', value: 1600, coalesceKey: 'fuel-main' })
    h = appReducer(h, { type: 'setFuel', tankId: 'main', value: 1700, coalesceKey: 'fuel-main' })
    expect(h.past).toHaveLength(1)
    expect(h.present.plan.fuel.main).toBe(1700)
    h = appReducer(h, { type: 'undo' })
    expect(h.present.plan.fuel.main).toBe(1450)
  })

  it('不同 coalesceKey 不合并；新操作清空 redo 栈', () => {
    let h = fresh()
    h = appReducer(h, { type: 'setBurn', value: 2000, coalesceKey: 'burn' })
    h = appReducer(h, { type: 'undo' })
    expect(h.future).toHaveLength(1)
    h = appReducer(h, { type: 'setFuel', tankId: 'aux', value: 100, coalesceKey: 'fuel-aux' })
    expect(h.future).toHaveLength(0)
    expect(h.present.plan.fuel.aux).toBe(100)
  })

  it('性能输入（温度/风/干湿等）可撤销重做', () => {
    let h = fresh()
    h = appReducer(h, { type: 'setPerf', patch: { oatC: 30 } })
    expect(h.present.perf.oatC).toBe(30)
    h = appReducer(h, { type: 'setPerf', patch: { surface: 'dry' }, coalesceKey: 'surface' })
    h = appReducer(h, { type: 'undo' })
    expect(h.present.perf.surface).toBe('wet')
    h = appReducer(h, { type: 'undo' })
    expect(h.present.perf.oatC).toBe(20)
  })

  it('采用候选整体替换方案并可撤销', () => {
    let h = fresh()
    const candidate: AppState = {
      plan: { ...h.present.plan, fuel: { aux: 0, main: 1000 } },
      perf: { ...createDefaultPerf(), endId: '35' },
    }
    h = appReducer(h, { type: 'applyCandidate', state: candidate })
    expect(h.present).toEqual(candidate)
    h = appReducer(h, { type: 'undo' })
    expect(h.present.plan.fuel.main).toBe(1450)
    expect(h.present.perf.endId).toBe('17')
  })

  it('非法配载动作不改状态也不入历史', () => {
    const h0 = fresh()
    const h1 = appReducer(h0, { type: 'assign', itemId: 'bag01', stationId: '3D' })
    expect(h1).toBe(h0)
  })

  it('reset 同时恢复配载与默认短湿跑道性能场景，且可撤销', () => {
    let h = fresh()
    h = appReducer(h, { type: 'setPerf', patch: { airportId: 'ZPBS', runwayId: 'rwy12', endId: '12', pressureAltFt: 780 } })
    h = appReducer(h, { type: 'setBurn', value: 2000 })
    h = appReducer(h, { type: 'reset' })
    expect(h.present).toEqual(createDefaultAppState())
    h = appReducer(h, { type: 'undo' })
    expect(h.present.plan.burn).toBe(2000)
    expect(h.present.perf.airportId).toBe('ZPBS')
  })
})

describe('持久化迁移', () => {
  it('v1 纯配载数据迁移为 v2：配载保留，性能输入取默认短湿跑道场景', () => {
    const v1 = { assignments: { pax01: '3D' }, fuel: { aux: 200, main: 1300 }, burn: 900 }
    const s = migrateV1ToV2(v1)
    expect(s.plan.assignments.pax01).toBe('3D')
    expect(s.plan.fuel.aux).toBe(200)
    expect(s.perf).toEqual(createDefaultPerf())
  })

  it('v1 非法字段在迁移时被钳制/丢弃', () => {
    const s = migrateV1ToV2({ assignments: { pax01: 'bagFwd', ghost: '1A' }, fuel: { aux: 999999 }, burn: -3 })
    expect(s.plan.assignments.pax01).toBeUndefined()
    expect(s.plan.assignments.ghost).toBeUndefined()
    expect(s.plan.fuel.aux).toBe(900)
    expect(s.plan.burn).toBe(0)
  })

  it('coerceAppState：v2 合法数据保留；未知机场/跑道回退默认；风向归一化', () => {
    const s = coerceAppState({
      plan: { assignments: {}, fuel: { aux: 10 }, burn: 50 },
      perf: { ...createDefaultPerf(), windDirDeg: 400, windSpeedKt: 5 },
    })
    expect(s.plan.fuel.aux).toBe(10)
    expect(s.perf.windDirDeg).toBe(40)
    const bad = coerceAppState({ plan: {}, perf: { airportId: 'NOPE', runwayId: 'x', endId: 'y' } })
    expect(bad.perf.airportId).toBe('ZLBS')
  })

  it('localStorage 往返：保存 v2 后恢复；存在 v1 时首次启动迁移', () => {
    const mem = new Map<string, string>()
    const ls = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
    } as unknown as Storage
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })

    try {
      const s = migrateV1ToV2({ burn: 1234 })
      saveAppState(s)
      expect(mem.has(STORAGE_KEY_V2)).toBe(true)
      const back = loadHistory()
      expect(back.present.plan.burn).toBe(1234)

      mem.clear()
      ls.setItem(STORAGE_KEY_V1, JSON.stringify({ burn: 777 }))
      const migrated = loadHistory()
      expect(migrated.present.plan.burn).toBe(777)
      expect(migrated.present.perf.runwayId).toBe('rwy17')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
    }
  })

  it('存储内容损坏时回退默认方案', () => {
    const ls = {
      getItem: () => '{not json',
      setItem: () => undefined,
    } as unknown as Storage
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
    try {
      const h = loadHistory()
      expect(h.present).toEqual(createDefaultAppState())
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
    }
  })
})
