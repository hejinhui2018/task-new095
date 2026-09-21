/**
 * 放行候选方案：当当前配载/跑道条件不能放行时，枚举可恢复放行的操作组合，
 * 并按「保留业载 → 落地燃油余量 → 操作改动数」排序。
 *
 * 候选种类：
 *  - runway      换跑道/方向（必要时换机场，气压高度取新机场标高库值，天气与干湿不变）
 *  - reduce-fuel 减油（先砍最后消耗的机翼主油箱，保留先耗的副油箱航程油）
 *  - offload     卸载乘客/行李（枚举 1–3 项组合，重量最接近缺口的优先）
 *  - mixed       减油 + 卸载（仅当纯减油无法满足时搜索，最多卸 1 项）
 *
 * 每个候选都经过与主流程完全相同的全量复验：结构重量、单舱、燃油可行性、
 * 全程重心包线（耗油轨迹）、起飞三阶段限重与着陆限重；任一不满足即淘汰。
 */

import type { Aircraft, LoadItem } from './types'
import { evaluateLoad, type Computed, type PlannerInput } from './limits'
import { evaluatePerformance, type PerformanceReport, type PerfInput } from './performance'
import { airports } from './airports'

export type CandidateKind = 'runway' | 'reduce-fuel' | 'offload' | 'mixed'

export const CANDIDATE_KIND_LABEL: Record<CandidateKind, string> = {
  runway: '换跑道 / 方向',
  'reduce-fuel': '减少燃油',
  offload: '卸载业载',
  mixed: '减油 + 卸载',
}

/** 落地最低保留燃油（lb，虚构公司政策） */
export const MIN_RESERVE_LB = 300

export interface Candidate {
  id: string
  kind: CandidateKind
  title: string
  /** 操作明细（人话） */
  changes: string[]
  plan: PlannerInput
  perf: PerfInput
  retainedPayloadLb: number
  landingFuelLb: number
  /** 操作改动数：每条配载/燃油/跑道调整计 1 */
  opsChanges: number
  removedItemIds: string[]
  fuelRemovedLb: number
  takeoffMarginLb: number
  landingMarginLb: number
}

export interface CandidateSet {
  candidates: Candidate[]
  /** 当前方案无法通过重量调整解决（如越界天气/无风数据）时为 true */
  onlyRunwaySwitch: boolean
}

interface Feasible {
  ok: boolean
  computed: Computed
  report?: PerformanceReport
}

function check(aircraft: Aircraft, items: LoadItem[], plan: PlannerInput, perf: PerfInput): Feasible {
  const computed = evaluateLoad(aircraft, items, plan)
  if (computed.issues.some((i) => i.severity === 'error')) {
    return { ok: false, computed }
  }
  const report = evaluatePerformance(
    aircraft,
    perf,
    { takeoffLb: computed.takeoff.weight, landingLb: computed.landing.weight },
  )
  return { ok: report.takeoffOk && report.landingOk, computed, report }
}

const round10 = (n: number) => Math.round(n / 10) * 10

/** 计算当前重量缺口：起飞/落地相对结构与性能控制限重的超出量（lb） */
function weightDeficit(
  aircraft: Aircraft,
  computed: Computed,
  report: PerformanceReport | undefined,
): number {
  let d = 0
  d = Math.max(d, computed.takeoff.weight - aircraft.mtow)
  d = Math.max(d, computed.landing.weight - aircraft.mlw)
  d = Math.max(d, computed.zfw.weight - aircraft.mzfw)
  if (report?.controllingTakeoff) {
    d = Math.max(d, computed.takeoff.weight - report.controllingTakeoff.effectiveLimitLb)
  }
  if (report?.controllingLanding) {
    d = Math.max(d, computed.landing.weight - report.controllingLanding.effectiveLimitLb)
  }
  return Math.max(0, round10(d))
}

/**
 * 减油：从最后消耗的油箱（数组末尾）向上砍，保持总油 ≥ 耗油 + 最低备份油。
 * 返回砍到目标总油量后的 fuel 表；不可行返回 null。
 */
function fuelAtTotal(aircraft: Aircraft, fuel: Record<string, number>, targetTotal: number): Record<string, number> | null {
  const tanks = aircraft.fuelTanks
  const current = tanks.map((t) => Math.min(Math.max(fuel[t.id] ?? 0, 0), t.capacity))
  let need = current.reduce((s, v) => s + v, 0) - targetTotal
  if (need < 0) return null
  const next = [...current]
  for (let i = tanks.length - 1; i >= 0 && need > 0; i--) {
    const cut = Math.min(next[i], need)
    next[i] -= cut
    need -= cut
  }
  // 向上取整到 10 lb：舍入后总油量只多不少，保证落地备份油不被舍掉
  const out: Record<string, number> = {}
  tanks.forEach((t, i) => (out[t.id] = Math.min(t.capacity, Math.ceil(next[i] / 10) * 10)))
  return out
}

/** 在 [floor, currentTotal] 间从最小砍油量开始扫描，找第一个可行减油方案 */
function findFuelReduction(
  aircraft: Aircraft,
  items: LoadItem[],
  plan: PlannerInput,
  perf: PerfInput,
  floor: number,
  step = 25,
): { plan: PlannerInput; f: Feasible; removed: number } | null {
  const tanks = aircraft.fuelTanks
  const total = tanks.reduce((s, t) => s + Math.min(Math.max(plan.fuel[t.id] ?? 0, 0), t.capacity), 0)
  for (let target = total - step; target >= floor - 1e-9; target -= step) {
    const fuel = fuelAtTotal(aircraft, plan.fuel, target)
    if (!fuel) continue
    const candidatePlan = { ...plan, fuel }
    const f = check(aircraft, items, candidatePlan, perf)
    if (f.ok) {
      const producedTotal = tanks.reduce((s, t) => s + (fuel[t.id] ?? 0), 0)
      return { plan: candidatePlan, f, removed: round10(total - producedTotal) }
    }
  }
  return null
}

interface Subset {
  ids: string[]
  weight: number
}

/** 枚举 1..maxSize 项、重量落在 [lo, hi] 内的全部子集，按（重量, 项数）升序 */
function enumerateSubsets(items: LoadItem[], maxSize: number, lo: number, hi: number): Subset[] {
  const out: Subset[] = []
  const rec = (start: number, chosen: number[], weight: number) => {
    if (chosen.length > 0 && weight >= lo && weight <= hi) {
      out.push({ ids: chosen.map((i) => items[i].id), weight: round10(weight) })
    }
    if (chosen.length === maxSize) return
    for (let i = start; i < items.length; i++) {
      const w = weight + items[i].weight
      if (w > hi + 1e-9) continue
      rec(i + 1, [...chosen, i], w)
    }
  }
  rec(0, [], 0)
  out.sort((a, b) => a.weight - b.weight || a.ids.length - b.ids.length)
  return out
}

function payloadOf(computed: Computed): number {
  return computed.placed.reduce((s, p) => s + p.item.weight, 0)
}

function pushCandidate(
  bucket: Candidate[],
  seen: Set<string>,
  c: Candidate,
) {
  const key = `${c.kind}|${[...c.removedItemIds].sort().join(',')}|${c.fuelRemovedLb}|${c.perf.airportId}/${c.perf.runwayId}/${c.perf.endId}`
  if (seen.has(key)) return
  seen.add(key)
  bucket.push(c)
}

/**
 * 生成候选方案。当前方案本身已可放行时返回空列表。
 */
export function generateCandidates(
  aircraft: Aircraft,
  items: LoadItem[],
  plan: PlannerInput,
  perf: PerfInput,
): CandidateSet {
  const current = check(aircraft, items, plan, perf)
  if (current.ok) return { candidates: [], onlyRunwaySwitch: false }

  const deficit = weightDeficit(aircraft, current.computed, current.report)
  const placedItems = current.computed.placed.map((p) => p.item)
  const currentPayload = payloadOf(current.computed)
  const currentLandingFuel = current.computed.totalFuel - current.computed.burnedTotal

  const bucket: Candidate[] = []
  const seen = new Set<string>()

  const margin = (f: Feasible) => {
    const report = f.report!
    const tm = report.controllingTakeoff ? report.controllingTakeoff.effectiveLimitLb - f.computed.takeoff.weight : 0
    const lm = report.controllingLanding ? report.controllingLanding.effectiveLimitLb - f.computed.landing.weight : 0
    return { tm, lm }
  }

  // ---- 1) 换跑道/方向（含换机场；保留全部业载与燃油，故排名最前）----
  for (const ap of airports) {
    for (const rw of ap.runways) {
      for (const end of rw.ends) {
        if (ap.id === perf.airportId && rw.id === perf.runwayId && end.id === perf.endId) continue
        const candidatePerf: PerfInput = {
          ...perf,
          airportId: ap.id,
          runwayId: rw.id,
          endId: end.id,
          // 换跑道后坡度/障碍物恢复为该跑道库值；气压高度改按新机场标高
          slopeOverridePct: null,
          obstacleOverride: null,
          pressureAltFt: ap.elevationFt,
        }
        const f = check(aircraft, items, plan, candidatePerf)
        if (!f.ok) continue
        const { tm, lm } = margin(f)
        const sameAirport = ap.id === perf.airportId
        pushCandidate(bucket, seen, {
          id: `rw-${ap.id}-${rw.id}-${end.id}`,
          kind: 'runway',
          title: sameAirport
            ? `改用 ${rw.name} 跑道 ${end.id} 号方向`
            : `改航至 ${ap.name} · 跑道 ${rw.name.replace('rwy', '')} ${end.id}`,
          changes: [
            `${sameAirport ? '换跑道/方向' : '换机场'}：${ap.name} ${rw.name} ${end.id}`,
            `TORA ${end.toraFt.toLocaleString()} ft · LDA ${end.ldaFt.toLocaleString()} ft · 坡度 ${end.slopePct}%`,
            '业载与燃油保持不变',
          ],
          plan,
          perf: candidatePerf,
          retainedPayloadLb: currentPayload,
          landingFuelLb: currentLandingFuel,
          opsChanges: 1,
          removedItemIds: [],
          fuelRemovedLb: 0,
          takeoffMarginLb: round10(tm),
          landingMarginLb: round10(lm),
        })
      }
    }
  }

  // ---- 重量/重心类调整在任何场景都尝试枚举；天气超表界等情形枚举自然无可行解 ----
  const fuelFloor = Math.max(current.computed.burnedTotal, plan.burn) + MIN_RESERVE_LB

  // ---- 2) 纯减油 ----
  const fuelCut = findFuelReduction(aircraft, items, plan, perf, fuelFloor)
  if (fuelCut) {
    const f2 = check(aircraft, items, fuelCut.plan, perf)
    const { tm, lm } = margin(f2)
    pushCandidate(bucket, seen, {
      id: 'fuel-min',
      kind: 'reduce-fuel',
      title: `减油 ${fuelCut.removed.toLocaleString()} lb`,
      changes: [
        `机载燃油减少 ${fuelCut.removed.toLocaleString()} lb（优先减最后消耗的机翼主油箱）`,
        `落地剩油 ${(currentLandingFuel - fuelCut.removed).toLocaleString()} lb（≥ 备份油 ${MIN_RESERVE_LB} lb）`,
        '业载保持不变',
      ],
      plan: fuelCut.plan,
      perf,
      retainedPayloadLb: currentPayload,
      landingFuelLb: currentLandingFuel - fuelCut.removed,
      opsChanges: 1,
      removedItemIds: [],
      fuelRemovedLb: fuelCut.removed,
      takeoffMarginLb: round10(tm),
      landingMarginLb: round10(lm),
    })
  }

  // ---- 3) 卸载 1–4 项：子集按重量升序复验，最多保留 40 个可行解 ----
  // 重量窗口：缺口附近（少 50 lb 到缺口 + 单件最大重量），既不漏解也限制复验次数
  const maxSingle = placedItems.reduce((m, i) => Math.max(m, i.weight), 0)
  const subsets = enumerateSubsets(
    placedItems,
    4,
    Math.max(0, deficit - 50),
    deficit + maxSingle + 50,
  )
  const nameOf = new Map(items.map((i) => [i.id, i]))
  let offloadKept = 0
  for (const s of subsets) {
    if (offloadKept >= 40) break
    const assignments = { ...plan.assignments }
    for (const id of s.ids) delete assignments[id]
    const candidatePlan = { ...plan, assignments }
    const f = check(aircraft, items, candidatePlan, perf)
    if (!f.ok) continue
    offloadKept += 1
    const { tm, lm } = margin(f)
    const removedNames = s.ids.map((id) => `${nameOf.get(id)!.name}（${nameOf.get(id)!.weight} lb）`)
    pushCandidate(bucket, seen, {
      id: `off-${s.ids.join('-')}`,
      kind: 'offload',
      title: `卸载 ${s.ids.length} 项 · ${s.weight.toLocaleString()} lb`,
      changes: [`卸下：${removedNames.join('、')}`, '燃油保持不变'],
      plan: candidatePlan,
      perf,
      retainedPayloadLb: currentPayload - s.weight,
      landingFuelLb: currentLandingFuel,
      opsChanges: s.ids.length,
      removedItemIds: s.ids,
      fuelRemovedLb: 0,
      takeoffMarginLb: round10(tm),
      landingMarginLb: round10(lm),
    })
  }

  // ---- 4) 减油 + 卸载（仅当纯减油不可行时，卸 1 项配合减油扫描）----
  if (!fuelCut) {
    for (const item of placedItems) {
      const assignments = { ...plan.assignments }
      delete assignments[item.id]
      const reduced: PlannerInput = { ...plan, assignments }
      const found = findFuelReduction(aircraft, items, reduced, perf, fuelFloor, 50)
      if (!found) continue
      const f2 = check(aircraft, items, found.plan, perf)
      if (!f2.ok) continue
      const { tm, lm } = margin(f2)
      pushCandidate(bucket, seen, {
        id: `mix-${item.id}`,
        kind: 'mixed',
        title: `卸下 ${item.name} + 减油 ${found.removed.toLocaleString()} lb`,
        changes: [
          `卸下 ${item.name}（${item.weight} lb）`,
          `机载燃油减少 ${found.removed.toLocaleString()} lb`,
          `落地剩油 ${(currentLandingFuel - found.removed).toLocaleString()} lb`,
        ],
        plan: found.plan,
        perf,
        retainedPayloadLb: currentPayload - item.weight,
        landingFuelLb: currentLandingFuel - found.removed,
        opsChanges: 2,
        removedItemIds: [item.id],
        fuelRemovedLb: found.removed,
        takeoffMarginLb: round10(tm),
        landingMarginLb: round10(lm),
      })
    }
  }

  // ---- 排序：保留业载 ↓ → 落地燃油 ↓ → 操作改动数 ↑ → 种类次序 ----
  const kindRank: Record<CandidateKind, number> = { runway: 0, 'reduce-fuel': 1, offload: 2, mixed: 3 }
  bucket.sort(
    (a, b) =>
      b.retainedPayloadLb - a.retainedPayloadLb ||
      b.landingFuelLb - a.landingFuelLb ||
      a.opsChanges - b.opsChanges ||
      kindRank[a.kind] - kindRank[b.kind],
  )

  // 截断时保证每一类的最优候选都能被看到（换跑道 / 减油 / 卸载 / 混合各取最多 3 个），
  // 其余名额按总排序补齐，最后整体仍按总排序展示。
  const MAX_CANDIDATES = 9
  const PER_KIND_QUOTA = 3
  const picked: Candidate[] = []
  const pickedIds = new Set<string>()
  for (const kind of ['runway', 'reduce-fuel', 'offload', 'mixed'] as CandidateKind[]) {
    let n = 0
    for (const c of bucket) {
      if (n >= PER_KIND_QUOTA) break
      if (c.kind === kind && !pickedIds.has(c.id)) {
        picked.push(c)
        pickedIds.add(c.id)
        n += 1
      }
    }
  }
  for (const c of bucket) {
    if (picked.length >= MAX_CANDIDATES) break
    if (!pickedIds.has(c.id)) {
      picked.push(c)
      pickedIds.add(c.id)
    }
  }
  picked.sort(
    (a, b) =>
      b.retainedPayloadLb - a.retainedPayloadLb ||
      b.landingFuelLb - a.landingFuelLb ||
      a.opsChanges - b.opsChanges ||
      kindRank[a.kind] - kindRank[b.kind],
  )

  return { candidates: picked.slice(0, MAX_CANDIDATES), onlyRunwaySwitch: picked.length === 0 }
}
