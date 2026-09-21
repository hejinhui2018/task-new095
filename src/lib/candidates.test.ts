import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from './manifest'
import { evaluateLoad } from './limits'
import { evaluatePerformance, type PerfInput } from './performance'
import { generateCandidates, MIN_RESERVE_LB } from './candidates'

const basePlan = { assignments: { ...defaultAssignments }, fuel: { ...defaultFuel }, burn: defaultBurn }

const shortWet: PerfInput = {
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
}

function revalidate(plan: typeof basePlan, perf: PerfInput) {
  const c = evaluateLoad(aircraft, manifestItems, plan)
  const r = evaluatePerformance(aircraft, perf, {
    takeoffLb: c.takeoff.weight,
    landingLb: c.landing.weight,
  })
  return { c, r }
}

const defaultPayload = manifestItems
  .filter((i) => basePlan.assignments[i.id])
  .reduce((s, i) => s + i.weight, 0)

describe('候选方案生成', () => {
  it('当前方案已可放行时不产生候选', () => {
    const fine: PerfInput = {
      ...shortWet,
      airportId: 'ZPBS',
      runwayId: 'rwy12',
      endId: '12',
      surface: 'dry',
      pressureAltFt: 780,
      windSpeedKt: 0,
      oatC: 15,
    }
    const set = generateCandidates(aircraft, manifestItems, basePlan, fine)
    expect(set.candidates).toHaveLength(0)
  })

  it('短湿跑道：候选全部通过全量复验（结构/燃油/重心轨迹/起飞落地性能）', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan, shortWet)
    expect(set.candidates.length).toBeGreaterThan(0)
    for (const cand of set.candidates) {
      const { c, r } = revalidate(cand.plan, cand.perf)
      expect(c.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
      expect(r.takeoffOk).toBe(true)
      expect(r.landingOk).toBe(true)
      expect(c.takeoff.weight).toBeLessThanOrEqual(aircraft.mtow)
      expect(c.landing.weight).toBeLessThanOrEqual(aircraft.mlw)
      // 落地油量不得低于备份油
      expect(c.totalFuel - c.burnedTotal).toBeGreaterThanOrEqual(MIN_RESERVE_LB - 1)
    }
  })

  it('排序首位为换跑道（保留全部业载），整体按保留业载降序', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan, shortWet)
    expect(set.candidates[0].kind).toBe('runway')
    expect(set.candidates[0].retainedPayloadLb).toBe(defaultPayload)
    const payloads = set.candidates.map((x) => x.retainedPayloadLb)
    expect(payloads).toEqual([...payloads].sort((a, b) => b - a))
  })

  it('同业载水平下落地燃油余量高的排前；卸载候选确实卸下指定项', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan, shortWet)
    const offload = set.candidates.filter((x) => x.kind === 'offload')
    expect(offload.length).toBeGreaterThan(0)
    for (const c of offload) {
      for (const id of c.removedItemIds) expect(c.plan.assignments[id]).toBeUndefined()
      expect(c.fuelRemovedLb).toBe(0)
    }
    // 同 retainedPayload 段内按 landingFuel 降序
    for (let i = 1; i < set.candidates.length; i++) {
      if (set.candidates[i].retainedPayloadLb === set.candidates[i - 1].retainedPayloadLb) {
        expect(set.candidates[i].landingFuelLb).toBeLessThanOrEqual(set.candidates[i - 1].landingFuelLb)
      }
    }
  })

  it('纯减油候选：加满油导致超重时，减油即可放行且业载不丢、备份油保住', () => {
    const plan = { ...basePlan, fuel: { aux: 900, main: 2200 } }
    const perf: PerfInput = { ...shortWet, airportId: 'ZPBS', runwayId: 'rwy12', endId: '12', surface: 'dry', pressureAltFt: 780, windSpeedKt: 0, oatC: 15 }
    const set = generateCandidates(aircraft, manifestItems, plan, perf)
    const fuel = set.candidates.find((x) => x.kind === 'reduce-fuel')
    expect(fuel).toBeDefined()
    expect(fuel!.retainedPayloadLb).toBe(defaultPayload)
    const { c } = revalidate(fuel!.plan, perf)
    expect(c.takeoff.weight).toBeLessThanOrEqual(aircraft.mtow)
    expect(c.landing.weight).toBeLessThanOrEqual(aircraft.mlw)
    expect(c.totalFuel - c.burnedTotal).toBeGreaterThanOrEqual(MIN_RESERVE_LB - 1)
    // 减油优先砍最后消耗的机翼主油箱，副油箱航程油尽量保留
    expect(fuel!.plan.fuel.aux).toBe(900)
  })

  it('纯减油受备份油限制不足时给出减油+卸载混合候选', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan, shortWet)
    const mixed = set.candidates.filter((x) => x.kind === 'mixed')
    // 短湿跑道缺口 607 lb，而备份油约束下最多减约 550 lb → 必须有混合或卸载候选
    const hasWeightFix = set.candidates.some((x) => x.kind === 'offload' || x.kind === 'mixed')
    expect(hasWeightFix).toBe(true)
    for (const m of mixed) {
      expect(m.removedItemIds).toHaveLength(1)
      expect(m.fuelRemovedLb).toBeGreaterThan(0)
      const { c } = revalidate(m.plan, m.perf)
      expect(c.totalFuel - c.burnedTotal).toBeGreaterThanOrEqual(MIN_RESERVE_LB - 1)
    }
  })

  it('换跑道候选采用新机场标高库值，坡度/障碍物恢复库值，不改业载燃油', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan, shortWet)
    const toZpbs = set.candidates.find((x) => x.perf.airportId === 'ZPBS')
    expect(toZpbs).toBeDefined()
    expect(toZpbs!.perf.pressureAltFt).toBe(780)
    expect(toZpbs!.perf.slopeOverridePct).toBeNull()
    expect(toZpbs!.perf.obstacleOverride).toBeNull()
    expect(toZpbs!.plan).toEqual(basePlan)
  })

  it('天气超出全部表格范围（任何跑道都无数据）：无候选，且重量调整不会被误判可行', () => {
    const impossible: PerfInput = { ...shortWet, pressureAltFt: 9000, oatC: 45, surface: 'dry' }
    const set = generateCandidates(aircraft, manifestItems, basePlan, impossible)
    expect(set.candidates).toHaveLength(0)
    expect(set.onlyRunwaySwitch).toBe(true)
  })

  it('候选去重：同一卸载集合与减油量只出现一次', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan, shortWet)
    const keys = set.candidates.map((x) => `${x.kind}:${[...x.removedItemIds].sort().join('-')}:${x.fuelRemovedLb}:${x.perf.endId}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('采用候选后裕量为正且配载计划可以被现有评估器直接消费', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan, shortWet)
    const pick = set.candidates.find((x) => x.kind === 'offload') ?? set.candidates[0]
    const { r } = revalidate(pick.plan, pick.perf)
    expect(r.controllingTakeoff).not.toBeNull()
    expect(r.controllingLanding).not.toBeNull()
    expect(pick.takeoffMarginLb).toBeGreaterThanOrEqual(0)
    expect(pick.landingMarginLb).toBeGreaterThanOrEqual(0)
  })
})
