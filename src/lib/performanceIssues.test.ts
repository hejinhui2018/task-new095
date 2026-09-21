import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from './manifest'
import { evaluateLoad } from './limits'
import { categoryPriority } from './limits'
import { evaluatePerformance, type PerfInput } from './performance'
import { performanceIssues } from './performanceIssues'

const load = evaluateLoad(aircraft, manifestItems, {
  assignments: { ...defaultAssignments },
  fuel: { ...defaultFuel },
  burn: defaultBurn,
})

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

describe('跑道性能告警适配', () => {
  it('短湿跑道：起飞超重问题进入告警，类别为 performance', () => {
    const r = evaluatePerformance(aircraft, shortWet, {
      takeoffLb: load.takeoff.weight,
      landingLb: load.landing.weight,
    })
    const issues = performanceIssues(r, load.takeoff.weight, load.landing.weight)
    expect(issues.some((i) => i.id === 'perf-tow-overweight' && i.severity === 'error')).toBe(true)
    // 着陆未超重则不报
    expect(issues.some((i) => i.id === 'perf-ldw-overweight')).toBe(false)
  })

  it('性能问题在优先级中仅次于结构重量，先于重心类', () => {
    expect(categoryPriority.performance).toBeLessThan(categoryPriority.envelope)
    expect(categoryPriority.weight).toBeLessThan(categoryPriority.performance)
  })

  it('阶段被拒绝时给出 error 级拒绝告警', () => {
    const r = evaluatePerformance(
      aircraft,
      { ...shortWet, pressureAltFt: 9000, oatC: 45, surface: 'dry' },
      { takeoffLb: load.takeoff.weight, landingLb: load.landing.weight },
    )
    const issues = performanceIssues(r, load.takeoff.weight, load.landing.weight)
    expect(issues.length).toBeGreaterThanOrEqual(4)
    expect(issues.every((i) => i.severity === 'error')).toBe(true)
    expect(issues[0].message).toContain('禁止外推')
  })

  it('全部通过时没有性能告警', () => {
    const r = evaluatePerformance(
      aircraft,
      { ...shortWet, airportId: 'ZPBS', runwayId: 'rwy12', endId: '12', surface: 'dry', pressureAltFt: 780, windSpeedKt: 0, oatC: 15 },
      { takeoffLb: load.takeoff.weight, landingLb: load.landing.weight },
    )
    expect(performanceIssues(r, load.takeoff.weight, load.landing.weight)).toHaveLength(0)
  })
})
