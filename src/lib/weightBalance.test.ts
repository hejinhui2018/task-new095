import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from './manifest'
import {
  buildStationMap,
  cgOf,
  fuelLoads,
  landingWeight,
  placeItems,
  planBurnSequence,
  takeoffWeight,
  zeroFuelWeight,
} from './weightBalance'

const stations = buildStationMap(aircraft)

function defaultTakeoff() {
  const { placed } = placeItems(manifestItems, defaultAssignments, stations)
  const zfw = zeroFuelWeight(aircraft, placed)
  return { zfw, takeoff: takeoffWeight(zfw, fuelLoads(aircraft, defaultFuel)) }
}

describe('力矩与重心计算', () => {
  it('单项力矩 = 重量 × 力臂', () => {
    const { placed } = placeItems(
      [{ id: 'x', kind: 'pax', name: '测试', weight: 180 }],
      { x: '1A' },
      stations,
    )
    expect(placed).toHaveLength(1)
    expect(placed[0].station.arm).toBe(125)
    expect(placed[0].moment).toBe(180 * 125)
  })

  it('未分配的载荷不计入重量', () => {
    const { placed, unassigned } = placeItems(manifestItems, {}, stations)
    expect(placed).toHaveLength(0)
    expect(unassigned).toHaveLength(manifestItems.length)
  })

  it('零油重量 = 空机 + 已装载乘客与行李', () => {
    const { placed } = placeItems(manifestItems, defaultAssignments, stations)
    const zfw = zeroFuelWeight(aircraft, placed)
    expect(zfw.weight).toBe(6737)
    expect(zfw.moment).toBeCloseTo(1_067_005, 0)
    expect(cgOf(zfw)).toBeCloseTo(158.38, 1)
  })

  it('起飞重量 = 零油重量 + 机载燃油', () => {
    const { takeoff } = defaultTakeoff()
    expect(takeoff.weight).toBe(8687)
    expect(takeoff.moment).toBeCloseTo(1_387_755, 0)
    expect(cgOf(takeoff)).toBeCloseTo(159.75, 2)
  })

  it('耗油顺序：先副油箱、后主油箱', () => {
    const seq = planBurnSequence(aircraft, { aux: 500, main: 1450 }, 1100)
    expect(seq.map((s) => [s.tank.id, s.amount])).toEqual([
      ['aux', 500],
      ['main', 600],
    ])
  })

  it('耗油量超过机载燃油时按可用燃油截断', () => {
    const seq = planBurnSequence(aircraft, { aux: 100, main: 200 }, 1000)
    expect(seq.reduce((s, x) => s + x.amount, 0)).toBe(300)
  })

  it('落地重量 = 起飞重量 − 耗油（含力矩）', () => {
    const { takeoff } = defaultTakeoff()
    const seq = planBurnSequence(aircraft, defaultFuel, defaultBurn)
    const lw = landingWeight(takeoff, seq)
    expect(lw.weight).toBe(8687 - 1100)
    expect(lw.moment).toBeCloseTo(1_198_755, 0)
    expect(cgOf(lw)).toBeCloseTo(158.0, 1)
  })

  it('载油量被钳制在油箱容量内', () => {
    const loads = fuelLoads(aircraft, { aux: 99999, main: -5 })
    const aux = loads.find((l) => l.tank.id === 'aux')!
    const main = loads.find((l) => l.tank.id === 'main')!
    expect(aux.amount).toBe(900)
    expect(main.amount).toBe(0)
  })
})
