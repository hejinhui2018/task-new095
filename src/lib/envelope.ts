import type { EnvelopePoint } from './types'

/** 某一重量下的重心前限与后限（力臂，in） */
export interface CGLimits {
  forward: number
  aft: number
}

/**
 * 包线随重量变化：在相邻节点间对前限/后限做线性插值；
 * 重量超出包线标注范围时钳制到端点值。
 */
export function cgLimitsAt(envelope: EnvelopePoint[], weight: number): CGLimits {
  if (envelope.length === 0) throw new Error('envelope is empty')
  const first = envelope[0]
  const last = envelope[envelope.length - 1]
  if (weight <= first.weight) return { forward: first.forwardArm, aft: first.aftArm }
  if (weight >= last.weight) return { forward: last.forwardArm, aft: last.aftArm }
  for (let i = 0; i < envelope.length - 1; i++) {
    const a = envelope[i]
    const b = envelope[i + 1]
    if (weight >= a.weight && weight <= b.weight) {
      const t = (weight - a.weight) / (b.weight - a.weight)
      return {
        forward: a.forwardArm + t * (b.forwardArm - a.forwardArm),
        aft: a.aftArm + t * (b.aftArm - a.aftArm),
      }
    }
  }
  return { forward: last.forwardArm, aft: last.aftArm }
}

export type EnvelopeSide = 'forward' | 'aft'

export interface EnvelopeViolation {
  side: EnvelopeSide
  /** 被越过的那条限制线在该重量下的值 */
  limit: number
}

/** 检查某 (重量, 重心) 点是否在包线内；边界视为包线内 */
export function envelopeViolation(
  envelope: EnvelopePoint[],
  weight: number,
  cg: number,
): EnvelopeViolation | null {
  const limits = cgLimitsAt(envelope, weight)
  if (cg < limits.forward) return { side: 'forward', limit: limits.forward }
  if (cg > limits.aft) return { side: 'aft', limit: limits.aft }
  return null
}

export function isInsideEnvelope(envelope: EnvelopePoint[], weight: number, cg: number): boolean {
  return envelopeViolation(envelope, weight, cg) === null
}
