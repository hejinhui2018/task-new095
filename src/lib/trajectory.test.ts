import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { defaultBurn, defaultFuel } from './manifest'
import { envelopeViolation } from './envelope'
import { planBurnSequence, type BurnStep } from './weightBalance'
import { buildTrajectory, findFirstViolation, phaseLabel } from './trajectory'

describe('燃油消耗轨迹', () => {
  const seq = planBurnSequence(aircraft, defaultFuel, defaultBurn)
  const takeoff = { weight: 8687, moment: 1_387_755 }
  const traj = buildTrajectory(takeoff, seq, { ...defaultFuel })

  it('轨迹从起飞开始、以落地结束', () => {
    expect(traj[0].phase).toBe('takeoff')
    expect(traj[0].weight).toBeCloseTo(8687, 5)
    const last = traj[traj.length - 1]
    expect(last.phase).toBe('landing')
    expect(last.weight).toBeCloseTo(7587, 5)
  })

  it('重量沿轨迹单调不增', () => {
    for (let i = 1; i < traj.length; i++) {
      expect(traj[i].weight).toBeLessThanOrEqual(traj[i - 1].weight)
    }
  })

  it('包含两个耗油阶段，且副油箱先耗、主油箱后耗', () => {
    const phases = traj.map((p) => p.phase)
    const firstAux = phases.indexOf('burn:aux')
    const firstMain = phases.indexOf('burn:main')
    expect(firstAux).toBeGreaterThan(0)
    expect(firstMain).toBeGreaterThan(firstAux)
  })

  it('轨迹点携带剩余燃油，可用于贡献追溯', () => {
    const last = traj[traj.length - 1]
    expect(last.fuelRemaining.aux).toBeCloseTo(0, 5)
    expect(last.fuelRemaining.main).toBeCloseTo(850, 5)
    expect(last.burned).toBeCloseTo(1100, 5)
  })

  it('默认航班全程在包线内', () => {
    expect(findFirstViolation(aircraft.envelope, traj)).toBeNull()
  })

  it('起飞点越界时首次越界阶段为起飞', () => {
    const bad = buildTrajectory({ weight: 8687, moment: 8687 * 200 }, [], {})
    const v = findFirstViolation(aircraft.envelope, bad)
    expect(v).not.toBeNull()
    expect(v!.point.phase).toBe('takeoff')
    expect(v!.side).toBe('aft')
  })

  it('端点合法但中途越界也能检出，并给出首次越界阶段', () => {
    // 构造包线：中部前限凸起，两端放宽
    const env = [
      { weight: 6000, forwardArm: 150, aftArm: 180 },
      { weight: 7000, forwardArm: 154, aftArm: 180 },
      { weight: 8000, forwardArm: 150, aftArm: 180 },
    ]
    // 先耗后油箱（臂 170，重心前移），再耗前油箱（臂 140，重心后移）
    const seq2: BurnStep[] = [
      { tank: { id: 'rear', name: '后油箱', arm: 170, capacity: 2000 }, amount: 1000 },
      { tank: { id: 'front', name: '前油箱', arm: 140, capacity: 2000 }, amount: 1000 },
    ]
    const t = buildTrajectory({ weight: 8000, moment: 8000 * 153 }, seq2, {
      rear: 1000,
      front: 1000,
    })
    // 两个端点都在包线内
    expect(envelopeViolation(env, t[0].weight, t[0].cg)).toBeNull()
    const last = t[t.length - 1]
    expect(envelopeViolation(env, last.weight, last.cg)).toBeNull()
    // 但轨迹中途越过前限
    const v = findFirstViolation(env, t)
    expect(v).not.toBeNull()
    expect(v!.side).toBe('forward')
    expect(v!.point.phase).toBe('burn:rear')
    expect(v!.point.weight).toBeLessThan(8000)
    expect(v!.point.weight).toBeGreaterThan(7000)
  })

  it('阶段标签', () => {
    expect(phaseLabel('takeoff', aircraft.fuelTanks)).toBe('起飞')
    expect(phaseLabel('landing', aircraft.fuelTanks)).toBe('落地')
    expect(phaseLabel('burn:aux', aircraft.fuelTanks)).toBe('巡航耗油（后部副油箱）')
  })
})
