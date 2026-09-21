import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from './manifest'
import { evaluatePlan, generateCandidates, type CandidatePlan } from './candidates'
import { defaultPerfInput } from './performance'

const basePlan: CandidatePlan = {
  assignments: { ...defaultAssignments },
  fuel: { ...defaultFuel },
  burn: defaultBurn,
  perf: defaultPerfInput(),
}

/** 默认航班：TOW 8687（油 1950）、LW 7587；湿 09 起飞限重 8225，需减 ≥462 lb */
describe('候选方案生成与校验', () => {
  it('默认短湿跑道方案：当前不满足（单发限重 8225 < 8687），候选集非空', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan)
    expect(set.alreadyOk).toBe(false)
    expect(set.valid.length + set.invalid.length).toBeGreaterThan(0)
  })

  it('减油候选：减 470 lb 后有效，保留全部业载，落地剩油 380 lb ≥ 0', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan)
    const fuel = set.valid.find((c) => c.kind === 'reduceFuel')
    expect(fuel).toBeDefined()
    const f = fuel!
    expect(f.computed.placed.length).toBe(manifestItems.length) // 未卸任何客/货
    expect(f.computed.totalFuel).toBe(1950 - 470)
    expect(f.fuelReserve).toBe(380)
    expect(f.computed.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    expect(f.perf.ok).toBe(true)
    expect(f.computed.takeoff.weight).toBe(8687 - 470)
    expect(f.computed.takeoff.weight).toBeLessThanOrEqual(f.perf.takeoffLimit!)
    // 逆耗油顺序：先减主油箱（后耗）
    expect(f.plan.fuel.main).toBe(1450 - 470)
    expect(f.plan.fuel.aux).toBe(500)
  })

  it('卸载候选：行李总重足够时只卸行李不卸乘客，减载 ≥ 缺口', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan)
    const bags = set.valid.find((c) => c.id === 'offload-bags')
    expect(bags).toBeDefined()
    const b = bags!
    const removedPax = manifestItems
      .filter((i) => i.kind === 'pax')
      .filter((i) => !(i.id in b.plan.assignments))
    expect(removedPax).toHaveLength(0)
    expect(b.title).toContain('6 件')
    expect(b.computed.takeoff.weight).toBeLessThanOrEqual(b.perf.takeoffLimit!)
  })

  it('所有有效候选都不得违反重心包线或落地限制', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan)
    expect(set.valid.length).toBeGreaterThan(0)
    for (const c of set.valid) {
      expect(c.computed.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
      expect(c.perf.ok).toBe(true)
      expect(c.computed.landing.weight).toBeLessThanOrEqual(c.perf.landingLimit!)
      expect(c.computed.takeoff.weight).toBeLessThanOrEqual(c.perf.takeoffLimit!)
    }
  })

  it('换跑道候选：长跑道 15/33 与反向 27 均被枚举；15 方向因障碍超限列入 invalid', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan)
    const keys = new Set(set.valid.concat(set.invalid).map((c) => `${c.plan.perf.runwayId}/${c.plan.perf.endIndex}`))
    expect(keys.has('rwy15/0')).toBe(true)
    expect(keys.has('rwy15/1')).toBe(true)
    expect(keys.has('rwy09/1')).toBe(true)
    // 反向 27 无障碍物，业载不变即可飞
    expect(set.valid.some((c) => c.plan.perf.runwayId === 'rwy09' && c.plan.perf.endIndex === 1)).toBe(true)
    // 15 方向有 30ft 障碍物 + 湿道面折减，原载荷仍超重 → invalid 且原因可追溯
    const rwy15 = set.invalid.find((c) => c.plan.perf.runwayId === 'rwy15' && c.plan.perf.endIndex === 0)
    expect(rwy15).toBeDefined()
    expect(rwy15!.invalidReasons.length).toBeGreaterThan(0)
  })

  it('排序：保留业载降序 → 落地剩油降序 → 操作改动升序', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan)
    const v = set.valid
    for (let i = 1; i < v.length; i++) {
      const a = v[i - 1]
      const b = v[i]
      // 前一名的排序键字典序不劣于后一名：b-a 的首个非零键 ≥0
      const lexCmp =
        a.payloadRetained - b.payloadRetained ||
        a.fuelReserve - b.fuelReserve ||
        b.changeScore - a.changeScore
      expect(lexCmp).toBeGreaterThanOrEqual(0)
    }
    // 同业载下，不卸油的换跑道候选（剩油 850）排在减油候选（剩油 380）之前
    const firstRunway = v.findIndex((c) => c.kind === 'runwayChange')
    const fuelIdx = v.findIndex((c) => c.id === 'reduce-fuel')
    expect(firstRunway).toBeGreaterThanOrEqual(0)
    expect(firstRunway).toBeLessThan(fuelIdx)
    // 卸载（损失业载）排在最后
    const offloadIdx = v.findIndex((c) => c.kind === 'offload')
    if (offloadIdx !== -1) expect(offloadIdx).toBe(v.length - 1)
  })

  it('顺风越界：减油/卸载无法修复故不生成；顺风方向列入 invalid，逆风方向（起降同向受益）有效', () => {
    const plan: CandidatePlan = {
      ...basePlan,
      perf: { ...basePlan.perf, windSpeed: 25, windDirection: 270 }, // 西风 25kt
    }
    const set = generateCandidates(aircraft, manifestItems, plan)
    // 减油/卸载不改变风，无法修复边界拒绝 → 不生成（不伪装）
    expect(set.valid.some((c) => c.kind === 'reduceFuel')).toBe(false)
    expect(set.invalid.some((c) => c.kind === 'reduceFuel')).toBe(false)
    // 09 / 15 方向为顺风分量（25 / 12.5 kt）→ 拒绝且留痕
    const rwy09 = set.invalid.find((c) => c.plan.perf.runwayId === 'rwy09' && c.plan.perf.endIndex === 0)
    expect(rwy09).toBeUndefined() // 当前方向不在候选枚举里
    const rwy15 = set.invalid.find((c) => c.plan.perf.runwayId === 'rwy15' && c.plan.perf.endIndex === 0)
    expect(rwy15).toBeDefined()
    expect(rwy15!.invalidReasons.join()).toContain('顺风')
    // 反向 27 / 33 变为逆风（起飞与着陆同方向都受益）→ 有效
    expect(set.valid.some((c) => c.plan.perf.runwayId === 'rwy09' && c.plan.perf.endIndex === 1)).toBe(true)
    expect(set.valid.some((c) => c.plan.perf.runwayId === 'rwy15' && c.plan.perf.endIndex === 1)).toBe(true)
  })

  it('当前方案本身合法时 alreadyOk=true，不生成修复候选', () => {
    const plan: CandidatePlan = { ...basePlan, perf: { ...basePlan.perf, surface: 'dry' } }
    const set = generateCandidates(aircraft, manifestItems, plan)
    expect(set.alreadyOk).toBe(true)
    expect(set.valid).toHaveLength(0)
    expect(set.invalid).toHaveLength(0)
  })

  it('候选方案可独立重新评估，结果一致', () => {
    const set = generateCandidates(aircraft, manifestItems, basePlan)
    const fuel = set.valid.find((c) => c.kind === 'reduceFuel')!
    const again = evaluatePlan(aircraft, manifestItems, fuel.plan)
    expect(again.perf.takeoffLimit).toBe(fuel.perf.takeoffLimit)
    expect(again.computed.takeoff.weight).toBe(fuel.computed.takeoff.weight)
  })
})
