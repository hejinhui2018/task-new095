import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from './manifest'
import { evaluateLoad } from './limits'
import {
  MAX_CROSSWIND_KT,
  MAX_HEADWIND_KT,
  MAX_TAILWIND_KT,
  PERF_OAT,
  PERF_PA,
  PERF_TABLE_VERSION,
  SLOPE_RANGE_PCT,
} from './perfTables'
import { decomposeWind, evaluatePerformance, obstacleGradient, type PerfInput } from './performance'

const load = evaluateLoad(aircraft, manifestItems, {
  assignments: { ...defaultAssignments },
  fuel: { ...defaultFuel },
  burn: defaultBurn,
})
const actual = { takeoffLb: load.takeoff.weight, landingLb: load.landing.weight }

/** 白山 17 号短湿跑道（内置示例）：库值 PA 2050、上坡 0.8%、障碍物 75ft/3200ft */
const zlbs17Wet = (over: Partial<PerfInput> = {}): PerfInput => ({
  airportId: 'ZLBS',
  runwayId: 'rwy17',
  endId: '17',
  surface: 'wet',
  oatC: 20,
  pressureAltFt: 2050,
  windDirDeg: 170,
  windSpeedKt: 10,
  slopeOverridePct: null,
  obstacleOverride: null,
  ...over,
})

describe('风分量分解', () => {
  it('逆风/顺风/侧风', () => {
    expect(decomposeWind(170, 170, 10).headwindKt).toBeCloseTo(10, 9)
    expect(decomposeWind(170, 350, 10).headwindKt).toBeCloseTo(-10, 9)
    const x = decomposeWind(170, 80, 10)
    expect(x.headwindKt).toBeCloseTo(0, 9)
    expect(x.crosswindKt).toBeCloseTo(10, 9)
  })
  it('45° 来风分量正确', () => {
    const w = decomposeWind(0, 45, 10 * Math.SQRT2)
    expect(w.headwindKt).toBeCloseTo(10, 9)
    expect(w.crosswindKt).toBeCloseTo(10, 9)
  })
})

describe('障碍物梯度', () => {
  it('高于屏隐高按水平距离算净梯度', () => {
    expect(obstacleGradient({ heightFt: 75, distanceFt: 3200 })).toBeCloseTo((40 / 3200) * 100, 9)
  })
  it('不高于 35ft 屏隐高视为无障碍', () => {
    expect(obstacleGradient({ heightFt: 35, distanceFt: 3000 })).toBe(0)
    expect(obstacleGradient({ heightFt: 20, distanceFt: 3000 })).toBe(0)
  })
})

describe('跑道性能放行', () => {
  it('报告带性能表版本号', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet(), actual)
    expect(r.version).toBe(PERF_TABLE_VERSION)
  })

  it('修正严格按 风 → 坡度 → 道面 顺序记录，累积系数为连乘', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet(), actual)
    const tod = r.stages.tod
    expect(tod.status).toBe('ok')
    if (tod.status !== 'ok') return
    const labels = tod.correctionTrace.map((s) => s.label)
    expect(labels.join('|')).toContain('风修正')
    expect(labels[0]).toMatch(/^风修正/)
    expect(labels[1]).toMatch(/^坡度修正/)
    expect(labels[2]).toMatch(/^道面修正/)
    // 顶风10kt ×0.900；上坡0.8% ×1.056；湿 ×1.15
    expect(tod.correctionTrace[0].factor).toBeCloseTo(0.9, 9)
    expect(tod.correctionTrace[1].factor).toBeCloseTo(1.056, 9)
    expect(tod.correctionTrace[2].factor).toBeCloseTo(1.15, 9)
    expect(tod.correctionTrace[2].cumulative).toBeCloseTo(0.9 * 1.056 * 1.15, 9)
  })

  it('短湿跑道示例：起飞受限（单发越障控制），着陆仍有正裕量', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet(), actual)
    expect(r.takeoffOk).toBe(false)
    expect(r.landingOk).toBe(true)
    expect(r.controllingTakeoff?.stage).toBe('climb-oei')
    expect(r.controllingLanding?.stage).toBe('mlw')
    const tod = r.stages.tod
    if (tod.status === 'ok') {
      expect(tod.marginLb).toBeLessThan(0)
      expect(tod.requiredDistanceFt).toBeGreaterThan(tod.availableDistanceFt!)
    }
    const ld = r.stages.landing
    expect(ld.status).toBe('ok')
    if (ld.status === 'ok') expect(ld.marginLb).toBeGreaterThan(0)
  })

  it('长干跑道：结构 MTOW/MLW 控制，裕量为正', () => {
    const r = evaluatePerformance(
      aircraft,
      zlbs17Wet({ airportId: 'ZPBS', runwayId: 'rwy12', endId: '12', surface: 'dry', windSpeedKt: 0, pressureAltFt: 780, oatC: 15 }),
      actual,
    )
    expect(r.takeoffOk).toBe(true)
    expect(r.landingOk).toBe(true)
    expect(r.controllingTakeoff?.stage).toBe('mtow')
    expect(r.controllingLanding?.stage).toBe('mlw')
  })

  it('气压高度超表界：全部阶段拒绝、无控制限重、提示禁止外推', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet({ pressureAltFt: PERF_PA[PERF_PA.length - 1] + 500 }), actual)
    expect(r.controllingTakeoff).toBeNull()
    expect(r.controllingLanding).toBeNull()
    expect(r.takeoffOk).toBe(false)
    expect(r.landingOk).toBe(false)
    for (const s of Object.values(r.stages)) {
      expect(s.status).toBe('rejected')
      if (s.status === 'rejected') {
        expect(s.code).toBe('pa-out-of-range')
        expect(s.message).toContain('禁止外推')
      }
    }
  })

  it('温度低于表注下限同样拒绝（不夹到边界）', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet({ oatC: PERF_OAT[0] - 5, surface: 'dry' }), actual)
    expect(r.rejections.every((s) => s.code === 'oat-out-of-range')).toBe(true)
  })

  it('湿道面超出批准的高度/温度范围 → wet-not-approved', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet({ pressureAltFt: 6500, oatC: 20 }), actual)
    expect(r.rejections.some((s) => s.code === 'wet-not-approved')).toBe(true)
    expect(r.takeoffOk).toBe(false)
    // 同一条件干道面在表内（6500 ft < 8000 上限）
    const dry = evaluatePerformance(aircraft, zlbs17Wet({ pressureAltFt: 6500, surface: 'dry' }), actual)
    expect(dry.stages.tod.status).toBe('ok')
  })

  it('顺风越界拒绝；顶风越界拒绝；侧风越界拒绝', () => {
    const tail = evaluatePerformance(aircraft, zlbs17Wet({ windSpeedKt: MAX_TAILWIND_KT + 5, windDirDeg: 350, surface: 'dry' }), actual)
    expect(tail.stages.tod).toMatchObject({ status: 'rejected', code: 'wind-tailwind' })
    expect(tail.stages.landing).toMatchObject({ status: 'rejected', code: 'wind-tailwind' })

    const head = evaluatePerformance(aircraft, zlbs17Wet({ windSpeedKt: MAX_HEADWIND_KT + 5, windDirDeg: 170, surface: 'dry' }), actual)
    expect(head.stages.tod).toMatchObject({ status: 'rejected', code: 'wind-headwind' })

    const cross = evaluatePerformance(
      aircraft,
      zlbs17Wet({ windSpeedKt: MAX_CROSSWIND_KT + 3, windDirDeg: 80, surface: 'dry' }),
      actual,
    )
    expect(cross.stages.tod).toMatchObject({ status: 'rejected', code: 'wind-crosswind' })
  })

  it('风分量恰在边界时允许（边界有效，不外推也不提前拒绝）', () => {
    const atTail = evaluatePerformance(
      aircraft,
      zlbs17Wet({ windSpeedKt: MAX_TAILWIND_KT, windDirDeg: 350, surface: 'dry' }),
      actual,
    )
    expect(atTail.stages.tod.status).not.toBe('rejected')
  })

  it('坡度超出 ±2% 拒绝；人工坡度覆盖标记为 user 并保留库值', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet({ slopeOverridePct: SLOPE_RANGE_PCT + 0.5, surface: 'dry' }), actual)
    expect(r.stages.tod).toMatchObject({ status: 'rejected', code: 'slope-out-of-range' })
    const ok = evaluatePerformance(aircraft, zlbs17Wet({ slopeOverridePct: -1.2, surface: 'dry' }), actual)
    expect(ok.resolved!.slope).toMatchObject({ value: -1.2, source: 'user', libraryValue: 0.8 })
    expect(ok.resolved!.obstacle.source).toBe('library')
  })

  it('修正后连表注最轻重量都超出可用距离 → field-below-table 拒绝，不夹边界', () => {
    const r = evaluatePerformance(
      aircraft,
      zlbs17Wet({
        oatC: 30,
        windSpeedKt: MAX_TAILWIND_KT,
        windDirDeg: 350,
        slopeOverridePct: SLOPE_RANGE_PCT,
      }),
      actual,
    )
    expect(r.stages.tod).toMatchObject({ status: 'rejected', code: 'field-below-table' })
    if (r.stages.tod.status === 'rejected') {
      expect(r.stages.tod.message).toContain('无可用限重')
    }
  })

  it('高温/高原空爬升表单元格 → climb-no-data，场长阶段照常计算', () => {
    const r = evaluatePerformance(
      aircraft,
      zlbs17Wet({
        airportId: 'ZPBS',
        runwayId: 'rwy12',
        endId: '12',
        pressureAltFt: 8000,
        oatC: 40,
        surface: 'dry',
        windSpeedKt: 0,
      }),
      actual,
    )
    expect(r.stages['climb-all']).toMatchObject({ status: 'rejected', code: 'climb-no-data' })
    expect(r.stages['climb-oei']).toMatchObject({ status: 'rejected', code: 'climb-no-data' })
    expect(r.stages.tod.status).toBe('ok')
    expect(r.stages.landing.status).toBe('ok')
    expect(r.controllingTakeoff).toBeNull()
  })

  it('障碍物梯度超过扣减表末档 → obstacle-no-data', () => {
    const r = evaluatePerformance(
      aircraft,
      zlbs17Wet({ surface: 'dry', obstacleOverride: { heightFt: 160, distanceFt: 1500 } }),
      actual,
    )
    expect(r.stages['climb-all']).toMatchObject({ status: 'rejected', code: 'obstacle-no-data' })
    expect(r.stages['climb-oei']).toMatchObject({ status: 'rejected', code: 'obstacle-no-data' })
    expect(r.stages.tod.status).toBe('ok')
  })

  it('障碍物人工覆盖来源标记 user 并可回到库值', () => {
    const r = evaluatePerformance(
      aircraft,
      zlbs17Wet({ obstacleOverride: { heightFt: 60, distanceFt: 2000 } }),
      actual,
    )
    const ob = r.resolved!.obstacle
    expect(ob.source).toBe('user')
    expect(ob.value).toEqual({ heightFt: 60, distanceFt: 2000 })
    expect(ob.libraryValue).toEqual({ heightFt: 75, distanceFt: 3200 })
  })

  it('未知机场/跑道直接拒绝', () => {
    const r = evaluatePerformance(aircraft, zlbs17Wet({ airportId: 'XXXX' }), actual)
    expect(r.takeoffOk).toBe(false)
    expect(r.landingOk).toBe(false)
    expect(r.resolved).toBeNull()
    expect(r.rejections.length).toBe(4)
  })
})
