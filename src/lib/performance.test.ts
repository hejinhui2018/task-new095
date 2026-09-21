import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { k12Performance } from './performanceData'
import {
  applyDistanceCorrections,
  defaultPerfInput,
  evaluateRunway,
  phaseOrder,
  phaseNames,
  windOnRunway,
  type PerfInput,
} from './performance'

/** 默认航班真实重量（ZFW 6737 + 油 1950；落地 = 8687 − 1100） */
const TOW = 8687
const LW = 7587

const evalDefault = (over: Partial<PerfInput> = {}) =>
  evaluateRunway(aircraft, { ...defaultPerfInput(), ...over }, { takeoffWeight: TOW, landingWeight: LW })

describe('风分解与顺风边界', () => {
  it('风向为来向：与跑道反向为逆风，同向为顺风，侧风按余弦分解', () => {
    expect(windOnRunway(10, 270, 90)).toBeCloseTo(-10, 6) // 09 方向上西风 = 顺风
    expect(windOnRunway(10, 90, 90)).toBeCloseTo(10, 6) // 09 方向上东风 = 逆风
    expect(windOnRunway(10, 180, 90)).toBeCloseTo(0, 6) // 正侧风
  })

  it('顺风恰好等于审定边界 10 kt：边界包含，允许计算', () => {
    const r = evalDefault({ windSpeed: 10, windDirection: 270 })
    expect(r.phases.groundRun.status).not.toBe('rejected')
    expect(r.headwindComponent).toBeCloseTo(-10, 1)
  })

  it('顺风 11 kt 超边界：所选方向的四阶段全部拒绝（着陆同方向、顺风边界对称）', () => {
    const r = evalDefault({ windSpeed: 11, windDirection: 270 })
    expect(r.ok).toBe(false)
    expect(r.takeoffLimit).toBeNull()
    expect(r.landingLimit).toBeNull()
    expect(r.phases.groundRun.error?.code).toBe('OUT_OF_RANGE')
    expect(r.phases.climbAllEngines.error?.code).toBe('OUT_OF_RANGE')
    expect(r.phases.climbOneEngine.error?.code).toBe('OUT_OF_RANGE')
    expect(r.phases.landing.error?.code).toBe('OUT_OF_RANGE')
    expect(r.phases.groundRun.error?.message).toContain('顺风')
    expect(r.headwindComponent).toBeCloseTo(-11, 1)
  })
})

describe('修正顺序：风 → 坡度 → 道面', () => {
  const c = k12Performance.corrections
  it('风对原始距离乘性修正、坡度对原始距离加性修正、湿道面最后整体乘性修正', () => {
    // 逆风 10kt、上坡 1.2%、湿：0.91 + 0.06 = 0.97，再 ×1.15 = 1.1155
    const r = applyDistanceCorrections(10, 1.2, 'wet', c, 'groundRun')
    expect(r.windFactor).toBeCloseTo(0.91, 10)
    expect(r.slopeAddCoefficient).toBeCloseTo(0.06, 10)
    expect(r.surfaceFactor).toBeCloseTo(1.15, 10)
    expect(r.factor).toBeCloseTo(1.1155, 10)
    expect(r.steps.map((s) => s.label)).toEqual(['① 风', '② 坡度', '③ 道面'])
  })

  it('顺序不可交换：坡度加性项不被风缩放（与全乘性叠加不同）', () => {
    // 规定顺序：(0.91 + 0.06) = 0.97；若错误地把坡度也乘性叠加：0.91×1.06 = 0.9646
    const prescribed = applyDistanceCorrections(10, 1.2, 'dry', c, 'groundRun').factor
    expect(prescribed).toBeCloseTo(0.97, 10)
    expect(prescribed).not.toBeCloseTo(0.91 * 1.06, 10)
  })

  it('反方向运行时坡度取反（下坡减小距离）', () => {
    const up = applyDistanceCorrections(10, 1.2, 'dry', c, 'groundRun').factor
    const down = applyDistanceCorrections(10, -1.2, 'dry', c, 'groundRun').factor
    expect(down).toBeLessThan(up)
  })

  it('来源链按顺序记录三个修正步骤与表版本', () => {
    const r = evalDefault()
    const chain = r.phases.groundRun.sources.find((s) => s.label.startsWith('修正顺序'))
    expect(chain?.detail).toContain('① 风')
    expect(chain?.detail).toContain('② 坡度')
    expect(chain?.detail).toContain('③ 道面')
    expect(r.sources[0].detail).toContain('K12-PERF-A1')
  })
})

describe('四阶段限重与控制阶段（短湿跑道示例）', () => {
  it('湿 09：起飞由单发越障控制，限重 8,225 lb，默认起飞 8,687 lb 超 462 lb', () => {
    const r = evalDefault()
    expect(r.ok).toBe(true)
    expect(r.takeoffControllingPhase).toBe('climbOneEngine')
    expect(r.takeoffLimit).toBe(8225)
    const one = r.phases.climbOneEngine
    expect(one.limitWeight).toBe(8225)
    expect(one.margin).toBe(-462)
    expect(one.status).toBe('limited')
    expect(one.referenceValue).toBeCloseTo(1.6, 1)
  })

  it('着陆限重独立于起飞限重（取 MLW 8500），不参与起飞控制取值', () => {
    const r = evalDefault()
    expect(r.landingLimit).toBe(aircraft.mlw)
    // 若错误地把着陆并入起飞取 min，起飞限重会被误报为 8500
    expect(r.takeoffLimit!).toBeLessThan(r.landingLimit!)
  })

  it('滑跑在短湿跑道上不控制：限重取结构 MTOW，裕量为正', () => {
    const r = evalDefault()
    expect(r.phases.groundRun.status).toBe('not-limiting')
    expect(r.phases.groundRun.limitWeight).toBe(aircraft.mtow)
    expect(r.phases.groundRun.margin).toBe(63)
  })

  it('距离条数值：当前重量修正后所需距离 < 公布可用距离', () => {
    const r = evalDefault()
    const g = r.phases.groundRun
    expect(g.actualValue).not.toBeNull()
    expect(g.referenceValue).toBe(3400)
    expect(g.actualValue!).toBeLessThan(3400)
  })

  it('干跑道单发限重放宽到结构 MTOW，默认方案起飞裕量转正', () => {
    const wet = evalDefault()
    const dry = evalDefault({ surface: 'dry' })
    expect(dry.phases.climbOneEngine.limitWeight).toBe(aircraft.mtow)
    expect(dry.phases.climbOneEngine.margin).toBe(63)
    expect(dry.takeoffLimit).toBe(aircraft.mtow)
    expect(dry.phases.climbOneEngine.limitWeight!).toBeGreaterThan(wet.phases.climbOneEngine.limitWeight!)
  })

  it('四阶段顺序固定，且每个成功阶段都有限重与裕量', () => {
    const r = evalDefault()
    expect(phaseOrder).toEqual(['groundRun', 'climbAllEngines', 'climbOneEngine', 'landing'])
    for (const p of phaseOrder) {
      expect(r.phases[p].status).not.toBe('rejected')
      expect(r.phases[p].limitWeight).not.toBeNull()
      expect(r.phases[p].margin).not.toBeNull()
      expect(r.phases[p].name).toBe(phaseNames[p])
    }
  })

  it('无障碍物方向：越障阶段不限制，限重取 MTOW', () => {
    const r = evalDefault({ endIndex: 1 }) // 27 方向无障碍
    expect(r.phases.climbAllEngines.status).toBe('not-limiting')
    expect(r.phases.climbAllEngines.limitWeight).toBe(aircraft.mtow)
    expect(r.phases.climbOneEngine.status).toBe('not-limiting')
  })
})

describe('表界与无数据必须拒绝', () => {
  it('气压高度超出表范围（>6000ft）：四阶段拒绝 OUT_OF_RANGE，限重为 null', () => {
    const r = evalDefault({ pressureAltitude: 6500 })
    expect(r.ok).toBe(false)
    expect(r.takeoffLimit).toBeNull()
    expect(r.landingLimit).toBeNull()
    for (const p of phaseOrder) {
      expect(r.phases[p].status).toBe('rejected')
      expect(r.phases[p].error?.code).toBe('OUT_OF_RANGE')
      expect(r.phases[p].error?.axis).toBe('altitude')
      expect(r.phases[p].limitWeight).toBeNull()
    }
  })

  it('气温超出表范围（<-10°C）：拒绝且不夹到边界', () => {
    const r = evalDefault({ temperature: -15 })
    expect(r.phases.groundRun.status).toBe('rejected')
    expect(r.phases.groundRun.error?.axis).toBe('temperature')
  })

  it('高×热条件遇到审定空洞：明确 NO_TABLE_DATA 拒绝，不外推', () => {
    const r = evalDefault({ pressureAltitude: 4000, temperature: 40 })
    expect(r.phases.climbOneEngine.status).toBe('rejected')
    expect(r.phases.climbOneEngine.error?.code).toBe('NO_TABLE_DATA')
    expect(r.phases.groundRun.status).toBe('rejected')
    expect(r.takeoffLimit).toBeNull()
  })

  it('顺风越界在查表之前拦截，拒绝时仍保留公布距离等来源链', () => {
    const r = evalDefault({ windSpeed: 11, windDirection: 270 })
    const g = r.phases.groundRun
    expect(g.status).toBe('rejected')
    expect(g.margin).toBeNull()
    expect(g.sources.some((s) => s.label === '公布可用距离')).toBe(true)
    expect(g.error?.message).toContain('11 kt')
  })

  it('找不到跑道：致命错误，全部阶段拒绝', () => {
    const r = evaluateRunway(
      aircraft,
      { ...defaultPerfInput(), runwayId: 'rwy99' },
      { takeoffWeight: TOW, landingWeight: LW },
    )
    expect(r.ok).toBe(false)
    expect(r.fatalError).not.toBeNull()
    expect(r.rejected).toHaveLength(4)
  })
})

describe('裕量与落地限制联动', () => {
  it('落地重量超过着陆限重时着陆裕量为负（即使起飞满足也不放行）', () => {
    const r = evaluateRunway(
      aircraft,
      defaultPerfInput(),
      { takeoffWeight: 8000, landingWeight: 8600 },
    )
    expect(r.phases.landing.margin).toBe(aircraft.mlw - 8600)
    expect(r.phases.landing.margin).toBeLessThan(0)
    expect(r.landingLimit).toBe(aircraft.mlw)
  })

  it('减油 470 lb 后单发裕量转正（−462 → +8），限重本身不随重量变化', () => {
    const r2 = evaluateRunway(
      aircraft,
      defaultPerfInput(),
      { takeoffWeight: TOW - 470, landingWeight: LW - 470 },
    )
    expect(r2.takeoffLimit).toBe(8225)
    expect(r2.phases.climbOneEngine.margin).toBe(8)
  })
})
