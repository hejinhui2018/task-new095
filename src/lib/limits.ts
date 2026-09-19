import type { Aircraft, LoadItem } from './types'
import {
  buildStationMap,
  cgOf,
  fuelLoads,
  landingWeight,
  placeItems,
  planBurnSequence,
  takeoffWeight,
  zeroFuelWeight,
  type BurnStep,
  type FuelLoad,
  type PlacedItem,
  type WeightMoment,
} from './weightBalance'
import { cgLimitsAt, type EnvelopeSide } from './envelope'
import {
  buildTrajectory,
  findFirstViolation,
  phaseLabel,
  type FirstViolation,
  type TrajectoryPoint,
} from './trajectory'

/** 配载方案输入：载荷分配 + 各油箱载油 + 预计耗油 */
export interface PlannerInput {
  assignments: Record<string, string>
  fuel: Record<string, number>
  burn: number
}

export type IssueCategory = 'weight' | 'compartment' | 'fuel' | 'envelope' | 'manifest'
export type Severity = 'error' | 'warning'

export interface Contributor {
  label: string
  detail: string
}

export interface Issue {
  id: string
  severity: Severity
  category: IssueCategory
  /** 重心越界时的首次越界阶段 */
  phase?: string
  message: string
  /** 可追溯的载荷贡献（按影响排序） */
  contributors: Contributor[]
}

/**
 * 限制优先级：结构重量限制 > 单舱限制 > 燃油可行性 > 重心包线 > 清单完整性。
 * 同级中 error 排在 warning 之前。
 */
export const categoryPriority: Record<IssueCategory, number> = {
  weight: 0,
  compartment: 1,
  fuel: 2,
  envelope: 3,
  manifest: 4,
}

export interface Computed {
  placed: PlacedItem[]
  unassigned: LoadItem[]
  compartmentTotals: Record<string, number>
  fuelLoads: FuelLoad[]
  totalFuel: number
  burnedTotal: number
  zfw: WeightMoment
  takeoff: WeightMoment
  landing: WeightMoment
  burnSequence: BurnStep[]
  trajectory: TrajectoryPoint[]
  firstViolation: FirstViolation | null
  issues: Issue[]
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

/** 对当前方案做完整评估：重量/力矩/重心、耗油轨迹、全部限制检查 */
export function evaluateLoad(aircraft: Aircraft, items: LoadItem[], input: PlannerInput): Computed {
  const stations = buildStationMap(aircraft)
  const { placed, unassigned } = placeItems(items, input.assignments, stations)
  const zfw = zeroFuelWeight(aircraft, placed)
  const fuels = fuelLoads(aircraft, input.fuel)
  const totalFuel = fuels.reduce((s, f) => s + f.amount, 0)
  const takeoff = takeoffWeight(zfw, fuels)
  const burnSequence = planBurnSequence(aircraft, input.fuel, input.burn)
  const landing = landingWeight(takeoff, burnSequence)
  const burnedTotal = burnSequence.reduce((s, b) => s + b.amount, 0)
  const initialFuel: Record<string, number> = {}
  for (const f of fuels) initialFuel[f.tank.id] = f.amount
  const trajectory = buildTrajectory(takeoff, burnSequence, initialFuel)
  const firstViolation = findFirstViolation(aircraft.envelope, trajectory)

  const compartmentTotals: Record<string, number> = {}
  for (const comp of aircraft.baggageCompartments) compartmentTotals[comp.id] = 0
  for (const p of placed) {
    if (p.station.kind === 'baggage') {
      compartmentTotals[p.station.id] = (compartmentTotals[p.station.id] ?? 0) + p.item.weight
    }
  }

  const issues: Issue[] = []

  // 1) 结构重量限制（最高优先级）
  const pushWeightIssue = (id: string, label: string, actual: number, limit: number) => {
    issues.push({
      id,
      severity: 'error',
      category: 'weight',
      message: `${label} ${fmt(actual)} lb 超过限制 ${fmt(limit)} lb（超出 ${fmt(actual - limit)} lb）`,
      contributors: weightContributors(aircraft, placed, fuels),
    })
  }
  if (zfw.weight > aircraft.mzfw) pushWeightIssue('weight-mzfw', '零油重量', zfw.weight, aircraft.mzfw)
  if (takeoff.weight > aircraft.mtow) pushWeightIssue('weight-mtow', '起飞重量', takeoff.weight, aircraft.mtow)
  if (landing.weight > aircraft.mlw) pushWeightIssue('weight-mlw', '落地重量', landing.weight, aircraft.mlw)

  // 2) 单舱限制（行李舱载量、油箱容量）
  for (const comp of aircraft.baggageCompartments) {
    const total = compartmentTotals[comp.id] ?? 0
    if (total > comp.maxWeight) {
      issues.push({
        id: `compartment-${comp.id}`,
        severity: 'error',
        category: 'compartment',
        message: `${comp.name} ${fmt(total)} lb 超过舱位限制 ${fmt(comp.maxWeight)} lb（超出 ${fmt(total - comp.maxWeight)} lb）`,
        contributors: placed
          .filter((p) => p.station.id === comp.id)
          .map((p) => ({ label: p.item.name, detail: `${fmt(p.item.weight)} lb` })),
      })
    }
  }
  for (const f of fuels) {
    const requested = input.fuel[f.tank.id] ?? 0
    if (requested > f.tank.capacity) {
      issues.push({
        id: `tank-${f.tank.id}`,
        severity: 'error',
        category: 'compartment',
        message: `${f.tank.name} 加油 ${fmt(requested)} lb 超过油箱容量 ${fmt(f.tank.capacity)} lb`,
        contributors: [],
      })
    }
  }

  // 3) 燃油可行性
  if (input.burn > totalFuel) {
    issues.push({
      id: 'fuel-burn',
      severity: 'error',
      category: 'fuel',
      message: `预计耗油 ${fmt(input.burn)} lb 超过机载燃油 ${fmt(totalFuel)} lb，落地前将燃油耗尽`,
      contributors: [],
    })
  }

  // 4) 重心包线：沿耗油轨迹检查，报告首次越界阶段与可追溯载荷贡献
  if (firstViolation) {
    const { point, side, limit } = firstViolation
    const sideLabel = side === 'forward' ? '前限' : '后限'
    issues.push({
      id: 'envelope-cg',
      severity: 'error',
      category: 'envelope',
      phase: point.phase,
      message: `重心轨迹在「${phaseLabel(point.phase, aircraft.fuelTanks)}」阶段越出包线${sideLabel}：` +
        `重量 ${fmt(point.weight)} lb 时重心 ${point.cg.toFixed(1)} in，该重量下${sideLabel}为 ${limit.toFixed(1)} in`,
      contributors: cgContributors(aircraft, placed, point, side),
    })
  }
  const zfwCg = cgOf(zfw)
  const zfwLimits = cgLimitsAt(aircraft.envelope, zfw.weight)
  if (zfwCg < zfwLimits.forward || zfwCg > zfwLimits.aft) {
    issues.push({
      id: 'envelope-zfw',
      severity: 'warning',
      category: 'envelope',
      message: `零油重心 ${zfwCg.toFixed(1)} in 超出包线 [${zfwLimits.forward.toFixed(1)}, ${zfwLimits.aft.toFixed(1)}] in，需通过燃油与装载调整回到包线内`,
      contributors: [],
    })
  }

  // 5) 清单完整性
  if (unassigned.length > 0) {
    issues.push({
      id: 'manifest-unassigned',
      severity: 'warning',
      category: 'manifest',
      message: `清单中有 ${unassigned.length} 项未装载，当前重量与重心未包含它们`,
      contributors: unassigned.map((i) => ({
        label: i.name,
        detail: `${i.kind === 'pax' ? '乘客' : '行李'} · ${fmt(i.weight)} lb`,
      })),
    })
  }

  issues.sort(
    (a, b) =>
      categoryPriority[a.category] - categoryPriority[b.category] ||
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1),
  )

  return {
    placed,
    unassigned,
    compartmentTotals,
    fuelLoads: fuels,
    totalFuel,
    burnedTotal,
    zfw,
    takeoff,
    landing,
    burnSequence,
    trajectory,
    firstViolation,
    issues,
  }
}

/** 超重问题的载荷贡献：按重量分组降序 */
function weightContributors(
  aircraft: Aircraft,
  placed: PlacedItem[],
  fuels: FuelLoad[],
): Contributor[] {
  const sum = (arr: PlacedItem[]) => arr.reduce((s, p) => s + p.item.weight, 0)
  const pax = placed.filter((p) => p.item.kind === 'pax')
  const bags = placed.filter((p) => p.item.kind === 'bag')
  const fuelTotal = fuels.reduce((s, f) => s + f.amount, 0)
  return [
    { label: '空机（含机组与设备）', detail: `${fmt(aircraft.emptyWeight)} lb`, w: aircraft.emptyWeight },
    { label: `乘客 ${pax.length} 人`, detail: `${fmt(sum(pax))} lb`, w: sum(pax) },
    { label: `行李 ${bags.length} 件`, detail: `${fmt(sum(bags))} lb`, w: sum(bags) },
    { label: '机载燃油', detail: `${fmt(fuelTotal)} lb`, w: fuelTotal },
  ]
    .sort((a, b) => b.w - a.w)
    .map(({ label, detail }) => ({ label, detail }))
}

/**
 * 重心越界的载荷贡献：越后限时列出位于重心之后的载荷（把重心往后拉），
 * 越前限时列出位于重心之前的载荷；按对重心的拉力矩降序，最多 5 条。
 */
function cgContributors(
  aircraft: Aircraft,
  placed: PlacedItem[],
  point: TrajectoryPoint,
  side: EnvelopeSide,
): Contributor[] {
  const cg = point.cg
  const onSide = (arm: number) =>
    side === 'aft' ? arm - cg > 0 : arm - cg < 0
  const entries: { label: string; detail: string; pull: number }[] = []
  for (const p of placed) {
    if (onSide(p.station.arm)) {
      entries.push({
        label: p.item.name,
        detail: `${fmt(p.item.weight)} lb @ ${p.station.arm} in · ${p.station.name}`,
        pull: p.item.weight * Math.abs(p.station.arm - cg),
      })
    }
  }
  for (const tank of aircraft.fuelTanks) {
    const amount = point.fuelRemaining[tank.id] ?? 0
    if (amount > 0 && onSide(tank.arm)) {
      entries.push({
        label: `${tank.name}剩余燃油`,
        detail: `${fmt(amount)} lb @ ${tank.arm} in`,
        pull: amount * Math.abs(tank.arm - cg),
      })
    }
  }
  return entries
    .sort((a, b) => b.pull - a.pull)
    .slice(0, 5)
    .map(({ label, detail }) => ({ label, detail }))
}
