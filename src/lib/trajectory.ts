import type { EnvelopePoint, FuelTank } from './types'
import type { BurnStep, WeightMoment } from './weightBalance'
import { envelopeViolation, type EnvelopeSide } from './envelope'

/**
 * 轨迹阶段：'takeoff'（起飞）| `burn:<tankId>`（某油箱耗油中）| 'landing'（落地）。
 * 用于报告首次越界发生在哪个阶段。
 */
export type TrajectoryPhase = string

export interface TrajectoryPoint {
  weight: number
  moment: number
  cg: number
  phase: TrajectoryPhase
  /** 到该点为止累计耗油 */
  burned: number
  /** 该点各油箱剩余燃油（用于追溯载荷贡献） */
  fuelRemaining: Record<string, number>
}

/**
 * 生成从起飞到落地的燃油消耗轨迹。
 * 每段耗油按约 5 lb 步长采样（段内重量与力矩线性变化），
 * 段末为油箱切换点，最后一个点为落地（phase = 'landing'）。
 */
export function buildTrajectory(
  takeoff: WeightMoment,
  burnSequence: BurnStep[],
  initialFuel: Record<string, number>,
): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = []
  const remaining: Record<string, number> = { ...initialFuel }
  let weight = takeoff.weight
  let moment = takeoff.moment
  let burnedBase = 0

  const makePoint = (
    phase: TrajectoryPhase,
    burned: number,
    fuelRemaining: Record<string, number>,
  ): TrajectoryPoint => ({
    weight,
    moment,
    cg: weight === 0 ? 0 : moment / weight,
    phase,
    burned,
    fuelRemaining,
  })

  points.push(makePoint('takeoff', 0, { ...remaining }))

  burnSequence.forEach((step, index) => {
    const isLast = index === burnSequence.length - 1
    const startWeight = weight
    const startMoment = moment
    const tankStart = remaining[step.tank.id] ?? 0
    const n = Math.min(Math.max(Math.round(step.amount / 5), 4), 200)
    for (let i = 1; i <= n; i++) {
      const f = i / n
      weight = startWeight - step.amount * f
      moment = startMoment - step.amount * step.tank.arm * f
      const phase: TrajectoryPhase = isLast && i === n ? 'landing' : `burn:${step.tank.id}`
      points.push(
        makePoint(phase, burnedBase + step.amount * f, {
          ...remaining,
          [step.tank.id]: tankStart - step.amount * f,
        }),
      )
    }
    remaining[step.tank.id] = tankStart - step.amount
    burnedBase += step.amount
  })

  if (burnSequence.length === 0) {
    points.push(makePoint('landing', 0, { ...remaining }))
  }
  return points
}

export interface FirstViolation {
  point: TrajectoryPoint
  side: EnvelopeSide
  limit: number
  index: number
}

/**
 * 沿整条轨迹逐点检查包线（而非只查起飞/落地两端），
 * 返回首次越界；全程在包线内返回 null。
 */
export function findFirstViolation(
  envelope: EnvelopePoint[],
  trajectory: TrajectoryPoint[],
): FirstViolation | null {
  for (let i = 0; i < trajectory.length; i++) {
    const p = trajectory[i]
    const v = envelopeViolation(envelope, p.weight, p.cg)
    if (v) return { point: p, side: v.side, limit: v.limit, index: i }
  }
  return null
}

/** 阶段的中文标签 */
export function phaseLabel(phase: TrajectoryPhase, tanks: FuelTank[]): string {
  if (phase === 'takeoff') return '起飞'
  if (phase === 'landing') return '落地'
  if (phase.startsWith('burn:')) {
    const tank = tanks.find((t) => `burn:${t.id}` === phase)
    return `巡航耗油（${tank ? tank.name : phase.slice(5)}）`
  }
  return phase
}
