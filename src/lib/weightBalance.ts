import type { Aircraft, FuelTank, LoadItem, StationInfo } from './types'

/** 一组重量与其总力矩 */
export interface WeightMoment {
  weight: number
  moment: number
}

/** 重心 = 总力矩 / 总重量；重量为 0 时返回 0（无意义占位） */
export function cgOf(wm: WeightMoment): number {
  return wm.weight === 0 ? 0 : wm.moment / wm.weight
}

export function sumWeightMoment(parts: WeightMoment[]): WeightMoment {
  return parts.reduce<WeightMoment>(
    (acc, p) => ({ weight: acc.weight + p.weight, moment: acc.moment + p.moment }),
    { weight: 0, moment: 0 },
  )
}

/** 建立站位查找表：座位（力臂取所在排）与行李舱 */
export function buildStationMap(aircraft: Aircraft): Map<string, StationInfo> {
  const map = new Map<string, StationInfo>()
  for (const row of aircraft.rows) {
    for (const seatId of row.seats) {
      map.set(seatId, { id: seatId, name: `座位 ${seatId}`, arm: row.arm, kind: 'seat' })
    }
  }
  for (const comp of aircraft.baggageCompartments) {
    map.set(comp.id, { id: comp.id, name: comp.name, arm: comp.arm, kind: 'baggage' })
  }
  return map
}

/** 已放置的载荷：条目 + 站位 + 力矩（重量 × 力臂） */
export interface PlacedItem {
  item: LoadItem
  station: StationInfo
  moment: number
}

/** 按分配表把清单条目放到站位上；未分配或站位非法的条目进入 unassigned，不计入重量 */
export function placeItems(
  items: LoadItem[],
  assignments: Record<string, string>,
  stations: Map<string, StationInfo>,
): { placed: PlacedItem[]; unassigned: LoadItem[] } {
  const placed: PlacedItem[] = []
  const unassigned: LoadItem[] = []
  for (const item of items) {
    const stationId = assignments[item.id]
    const station = stationId ? stations.get(stationId) : undefined
    if (station) {
      placed.push({ item, station, moment: item.weight * station.arm })
    } else {
      unassigned.push(item)
    }
  }
  return { placed, unassigned }
}

/** 零油重量 = 空机 + 已装载乘客与行李 */
export function zeroFuelWeight(aircraft: Aircraft, placed: PlacedItem[]): WeightMoment {
  return sumWeightMoment([
    { weight: aircraft.emptyWeight, moment: aircraft.emptyWeight * aircraft.emptyArm },
    ...placed.map((p) => ({ weight: p.item.weight, moment: p.moment })),
  ])
}

export interface FuelLoad {
  tank: FuelTank
  amount: number
  moment: number
}

/** 各油箱实际载油量（钳制到 [0, 容量]）及其力矩 */
export function fuelLoads(aircraft: Aircraft, fuel: Record<string, number>): FuelLoad[] {
  return aircraft.fuelTanks.map((tank) => {
    const amount = Math.min(Math.max(fuel[tank.id] ?? 0, 0), tank.capacity)
    return { tank, amount, moment: amount * tank.arm }
  })
}

/** 起飞重量 = 零油重量 + 机载燃油 */
export function takeoffWeight(zfw: WeightMoment, loads: FuelLoad[]): WeightMoment {
  return sumWeightMoment([zfw, ...loads.map((l) => ({ weight: l.amount, moment: l.moment }))])
}

/** 耗油序列中的一段：从某个油箱耗掉多少燃油 */
export interface BurnStep {
  tank: FuelTank
  amount: number
}

/**
 * 把预计总耗油按油箱耗油顺序（fuelTanks 数组序）分配：
 * 先耗尽排在前面的油箱，再耗后面的。超过机载燃油的部分被截断。
 */
export function planBurnSequence(
  aircraft: Aircraft,
  fuel: Record<string, number>,
  burn: number,
): BurnStep[] {
  let remaining = Math.max(burn, 0)
  const steps: BurnStep[] = []
  for (const tank of aircraft.fuelTanks) {
    if (remaining <= 0) break
    const available = Math.min(Math.max(fuel[tank.id] ?? 0, 0), tank.capacity)
    const amount = Math.min(available, remaining)
    if (amount > 0) steps.push({ tank, amount })
    remaining -= amount
  }
  return steps
}

/** 落地重量 = 起飞重量 − 各段耗油 */
export function landingWeight(takeoff: WeightMoment, burnSequence: BurnStep[]): WeightMoment {
  const burned = sumWeightMoment(
    burnSequence.map((s) => ({ weight: s.amount, moment: s.amount * s.tank.arm })),
  )
  return { weight: takeoff.weight - burned.weight, moment: takeoff.moment - burned.moment }
}
