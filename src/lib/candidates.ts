/**
 * 候选方案：在当前方案超重 / 性能条件被拒绝时，自动生成
 * 「减油」「卸载」「换跑道」三类候选，逐一重新做配载评估与跑道放行计算，
 * 只保留同时满足结构、重心、燃油可行性与四阶段性能限制的方案，
 * 并按 保留业载 → 落地燃油余量 → 操作改动量 排序。
 */
import type { Aircraft, LoadItem } from './types'
import { evaluateLoad, type Computed } from './limits'
import {
  evaluateRunway,
  phaseOrder,
  type PerfInput,
  type PerfResult,
} from './performance'
import { k12Performance, airports, type AircraftPerformance } from './performanceData'

/** 候选对应的完整方案（与 store.PlannerState 结构兼容） */
export interface CandidatePlan {
  assignments: Record<string, string>
  fuel: Record<string, number>
  burn: number
  perf: PerfInput
}

export type CandidateKind = 'reduceFuel' | 'offload' | 'runwayChange'

export interface Candidate {
  id: string
  kind: CandidateKind
  title: string
  /** 应用后与当前方案的差异（人读） */
  changes: string[]
  plan: CandidatePlan
  /** 重新评估结果 */
  valid: boolean
  invalidReasons: string[]
  /** 排序指标 */
  payloadRetained: number
  fuelReserve: number
  changeScore: number
  computed: Computed
  perf: PerfResult
}

export interface CandidateSet {
  /** 全部有效候选（已排序） */
  valid: Candidate[]
  /** 无效尝试（明确标注原因，不得应用） */
  invalid: Candidate[]
  /** 当前方案是否本就满足全部限制 */
  alreadyOk: boolean
}

/** 对候选方案做完整评估（配载 + 跑道） */
export function evaluatePlan(
  aircraft: Aircraft,
  items: LoadItem[],
  plan: CandidatePlan,
  perfData: AircraftPerformance = k12Performance,
): { computed: Computed; perf: PerfResult } {
  const computed = evaluateLoad(aircraft, items, plan)
  const perf = evaluateRunway(
    aircraft,
    plan.perf,
    { takeoffWeight: computed.takeoff.weight, landingWeight: computed.landing.weight },
    perfData,
  )
  return { computed, perf }
}

/** 校验方案：不得有结构/重心/燃油错误，四阶段可算且重量不超限 */
function validate(
  computed: Computed,
  perf: PerfResult,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = []
  for (const issue of computed.issues) {
    if (issue.severity === 'error') reasons.push(issue.message)
  }
  if (!perf.ok) {
    for (const p of phaseOrder) {
      const ph = perf.phases[p]
      if (ph.status === 'rejected' && ph.error) reasons.push(`${ph.name}：${ph.error.message}`)
    }
  } else {
    const towLimit = perf.takeoffLimit ?? Infinity
    const landLimit = perf.landingLimit ?? Infinity
    if (computed.takeoff.weight > towLimit) {
      reasons.push(`起飞重量 ${computed.takeoff.weight} > 起飞限重 ${towLimit}`)
    }
    if (computed.landing.weight > landLimit) {
      reasons.push(`落地重量 ${computed.landing.weight} > 着陆限重 ${landLimit}`)
    }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] }
}

interface GenContext {
  aircraft: Aircraft
  items: LoadItem[]
  plan: CandidatePlan
  computed: Computed
  perf: PerfResult
  perfData: AircraftPerformance
}

/** 业载重量（已装载乘客+行李） */
function payloadWeight(computed: Computed): number {
  return computed.placed.reduce((s, p) => s + p.item.weight, 0)
}

/** 当前需要减去的重量（同时覆盖起飞与落地裕量缺口） */
function requiredReduction(computed: Computed, perf: PerfResult): number | null {
  if (!perf.ok) return null
  const need = Math.max(
    computed.takeoff.weight - (perf.takeoffLimit ?? Infinity),
    computed.landing.weight - (perf.landingLimit ?? Infinity),
    0,
  )
  return need
}

function buildCandidate(
  id: string,
  kind: CandidateKind,
  title: string,
  changes: string[],
  plan: CandidatePlan,
  changeScore: number,
  ctx: GenContext,
): Candidate {
  const { computed, perf } = evaluatePlan(ctx.aircraft, ctx.items, plan, ctx.perfData)
  const { valid, reasons } = validate(computed, perf)
  return {
    id,
    kind,
    title,
    changes,
    plan,
    valid,
    invalidReasons: reasons,
    payloadRetained: payloadWeight(computed),
    fuelReserve: computed.totalFuel - computed.burnedTotal,
    changeScore,
    computed,
    perf,
  }
}

/** 减油：从最后消耗的油箱开始减（保留航程前段用油），步进 10 lb */
function reduceFuelCandidates(ctx: GenContext): Candidate[] {
  const need = requiredReduction(ctx.computed, ctx.perf)
  if (need === null) return []
  const reduceBy = Math.ceil(need / 10) * 10
  const tanks = ctx.aircraft.fuelTanks
  const maxReduction = ctx.computed.totalFuel - ctx.plan.burn // 须保留可飞完预计航程的油
  if (reduceBy <= 0) return []

  const fuel = { ...ctx.plan.fuel }
  let remaining = reduceBy
  if (reduceBy <= maxReduction) {
    // 逆耗油顺序：先减主油箱（最后耗），再减副油箱
    for (const tank of [...tanks].reverse()) {
      if (remaining <= 0) break
      const have = fuel[tank.id] ?? 0
      const take = Math.min(have, remaining)
      fuel[tank.id] = have - take
      remaining -= take
    }
  }
  const feasible = reduceBy <= maxReduction
  const plan: CandidatePlan = { ...ctx.plan, fuel }
  const changes = [
    `减载燃油 ${reduceBy} lb（逆耗油顺序）`,
    feasible ? '' : `但最多只能减 ${Math.max(maxReduction, 0)} lb（须保留航程用油 ${ctx.plan.burn} lb），仍超重`,
  ].filter(Boolean)
  return [
    buildCandidate(
      'reduce-fuel',
      'reduceFuel',
      `减油 ${reduceBy} lb`,
      changes,
      plan,
      1 + reduceBy / 100,
      ctx,
    ),
  ]
}

/** 卸载：给定候选物品 id 集合，构造方案 */
function offloadPlan(ctx: GenContext, ids: Set<string>): CandidatePlan {
  const assignments: Record<string, string> = {}
  for (const [itemId, station] of Object.entries(ctx.plan.assignments)) {
    if (!ids.has(itemId)) assignments[itemId] = station
  }
  return { ...ctx.plan, assignments }
}

/** 按重量从小到大选物品，直到累计减载达到 need */
function pickSmallest(
  pool: { id: string; weight: number; kind: string }[],
  need: number,
): Set<string> {
  const picked = new Set<string>()
  let sum = 0
  for (const it of [...pool].sort((a, b) => a.weight - b.weight)) {
    if (sum >= need) break
    picked.add(it.id)
    sum += it.weight
  }
  return picked
}

function offloadCandidates(ctx: GenContext): Candidate[] {
  const need = requiredReduction(ctx.computed, ctx.perf)
  if (need === null || need <= 0) return []
  const placed = ctx.computed.placed.map((p) => ({
    id: p.item.id,
    weight: p.item.weight,
    kind: p.item.kind,
    name: p.item.name,
  }))
  const out: Candidate[] = []

  // 候选 A：优先卸行李（尽量不甩客）
  const bags = placed.filter((p) => p.kind === 'bag')
  const bagPick = pickSmallest(bags, need)
  const bagWeight = [...bagPick].reduce(
    (s, id) => s + (placed.find((p) => p.id === id)?.weight ?? 0),
    0,
  )
  if (bagWeight >= need) {
    const names = [...bagPick].map((id) => placed.find((p) => p.id === id)?.name ?? id)
    out.push(
      buildCandidate(
        'offload-bags',
        'offload',
        `卸行李 ${bagPick.size} 件（${bagWeight} lb）`,
        [`卸下 ${names.join('、')}`],
        offloadPlan(ctx, bagPick),
        50 + bagPick.size * 5,
        ctx,
      ),
    )
  }

  // 候选 B：全部业载中最小重量优先（减载最少，可能含乘客）
  const anyPick = pickSmallest(placed, need)
  const anyWeight = [...anyPick].reduce(
    (s, id) => s + (placed.find((p) => p.id === id)?.weight ?? 0),
    0,
  )
  const paxN = [...anyPick].filter((id) => placed.find((p) => p.id === id)?.kind === 'pax').length
  const bagN = anyPick.size - paxN
  if (anyWeight >= need && anyPick.size !== bagPick.size) {
    out.push(
      buildCandidate(
        'offload-mix',
        'offload',
        `卸载 ${paxN} 名乘客 + ${bagN} 件行李（${anyWeight} lb）`,
        [`卸下 ${[...anyPick].map((id) => placed.find((p) => p.id === id)?.name ?? id).join('、')}`],
        offloadPlan(ctx, anyPick),
        50 + paxN * 20 + bagN * 5,
        ctx,
      ),
    )
  }
  return out
}

/** 换跑道（含同跑道反向）：保持载荷与气象输入，枚举其他跑道端 */
function runwayCandidates(ctx: GenContext): Candidate[] {
  const out: Candidate[] = []
  const currentKey = `${ctx.plan.perf.airportId}/${ctx.plan.perf.runwayId}/${ctx.plan.perf.endIndex}`
  for (const airport of airports) {
    for (const runway of airport.runways) {
      for (const endIndex of [0, 1] as const) {
        const key = `${airport.id}/${runway.id}/${endIndex}`
        if (key === currentKey) continue
        const perf: PerfInput = {
          ...ctx.plan.perf,
          airportId: airport.id,
          runwayId: runway.id,
          endIndex,
        }
        const sameRunway = runway.id === ctx.plan.perf.runwayId
        const end = runway.ends[endIndex]
        out.push(
          buildCandidate(
            `runway-${runway.id}-${end.designator}`,
            'runwayChange',
            `改用跑道 ${runway.name} 方向 ${end.designator}`,
            [
              sameRunway ? '同跑道反向运行' : `改用 ${runway.name}（${runway.surface === 'concrete' ? '水泥' : '沥青'}道面）`,
              `公布可用距离 ${end.tora} ft${end.obstacleHeight > 0 ? `，障碍物 ${end.obstacleHeight} ft @ ${end.obstacleDistance} ft` : '，无障碍物'}`,
            ],
            { ...ctx.plan, perf },
            sameRunway ? 8 : 15,
            ctx,
          ),
        )
      }
    }
  }
  return out
}

/**
 * 生成候选集。当前方案已满足全部限制时不生成修复候选。
 * 排序：有效在前；保留业载降序 → 落地剩油降序 → 操作改动升序。
 */
export function generateCandidates(
  aircraft: Aircraft,
  items: LoadItem[],
  plan: CandidatePlan,
  perfData: AircraftPerformance = k12Performance,
): CandidateSet {
  const { computed, perf } = evaluatePlan(aircraft, items, plan, perfData)
  const current = validate(computed, perf)
  if (current.valid) {
    return { valid: [], invalid: [], alreadyOk: true }
  }
  const ctx: GenContext = { aircraft, items, plan, computed, perf, perfData }
  const all = [...reduceFuelCandidates(ctx), ...offloadCandidates(ctx), ...runwayCandidates(ctx)]
  const valid = all
    .filter((c) => c.valid)
    .sort(
      (a, b) =>
        b.payloadRetained - a.payloadRetained ||
        b.fuelReserve - a.fuelReserve ||
        a.changeScore - b.changeScore,
    )
  const invalid = all.filter((c) => !c.valid)
  return { valid, invalid, alreadyOk: false }
}
