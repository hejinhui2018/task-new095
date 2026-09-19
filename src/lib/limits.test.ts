import { describe, expect, it } from 'vitest'
import { aircraft } from './aircraft'
import { defaultAssignments, defaultBurn, defaultFuel, manifestItems } from './manifest'
import { categoryPriority, evaluateLoad } from './limits'

const base = {
  assignments: { ...defaultAssignments },
  fuel: { ...defaultFuel },
  burn: defaultBurn,
}

/** 乘客尽量后移 + 全部行李入后舱（后舱超限、重心靠后） */
const rearHeavyAssignments: Record<string, string> = {
  pax06: '3A',
  pax07: '3B',
  pax01: '3C',
  pax03: '3D',
  pax09: '2A',
  pax04: '2B',
  pax08: '2C',
  pax02: '2D',
  pax05: '1A',
  pax10: '1B',
  bag01: 'bagAft',
  bag02: 'bagAft',
  bag03: 'bagAft',
  bag04: 'bagAft',
  bag05: 'bagAft',
  bag06: 'bagAft',
  bag07: 'bagAft',
}

/** 乘客尽量前移 + 全部行李入前舱（重心靠前） */
const frontHeavyAssignments: Record<string, string> = {
  pax06: '1A',
  pax07: '1B',
  pax01: '1C',
  pax03: '1D',
  pax09: '2A',
  pax04: '2B',
  pax08: '2C',
  pax02: '2D',
  pax05: '3A',
  pax10: '3B',
  bag01: 'bagFwd',
  bag02: 'bagFwd',
  bag03: 'bagFwd',
  bag04: 'bagFwd',
  bag05: 'bagFwd',
  bag06: 'bagFwd',
  bag07: 'bagFwd',
}

describe('限制检查与优先级', () => {
  it('默认航班没有错误级问题', () => {
    const c = evaluateLoad(aircraft, manifestItems, base)
    expect(c.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  it('超重：指出具体限制值与超出量，贡献可追溯', () => {
    const c = evaluateLoad(aircraft, manifestItems, {
      ...base,
      fuel: { aux: 900, main: 2200 },
    })
    const issue = c.issues.find((i) => i.id === 'weight-mtow')
    expect(issue).toBeDefined()
    expect(issue!.message).toContain('8,750')
    expect(issue!.message).toContain('1,087')
    expect(issue!.contributors.map((x) => x.label).join()).toContain('燃油')
  })

  it('单舱超限：指出舱位与限制，列出舱内物品', () => {
    const c = evaluateLoad(aircraft, manifestItems, { ...base, assignments: rearHeavyAssignments })
    const issue = c.issues.find((i) => i.id === 'compartment-bagAft')
    expect(issue).toBeDefined()
    expect(issue!.message).toContain('后行李舱')
    expect(issue!.message).toContain('450')
    expect(issue!.contributors).toHaveLength(7)
  })

  it('重心越界（起飞即越后限）：给出首次越界阶段与后拉载荷', () => {
    const c = evaluateLoad(aircraft, manifestItems, {
      assignments: rearHeavyAssignments,
      fuel: { aux: 900, main: 0 },
      burn: 300,
    })
    const issue = c.issues.find((i) => i.id === 'envelope-cg')
    expect(issue).toBeDefined()
    expect(issue!.phase).toBe('takeoff')
    expect(issue!.message).toContain('后限')
    expect(issue!.contributors.length).toBeGreaterThan(0)
    // 贡献最大的是后部的副油箱燃油（900 lb @ 192 in），清单中同时包含后舱行李
    expect(issue!.contributors[0].label).toContain('副油箱')
    expect(issue!.contributors[0].detail).toContain('@ 192 in')
    expect(issue!.contributors.some((x) => x.detail.includes('@ 235 in'))).toBe(true)
  })

  it('重心越界（途中越前限）：起飞合法，耗油途中首次越界', () => {
    const c = evaluateLoad(aircraft, manifestItems, {
      assignments: frontHeavyAssignments,
      fuel: { aux: 900, main: 0 },
      burn: 900,
    })
    // 起飞点在包线内
    expect(c.firstViolation).not.toBeNull()
    expect(c.firstViolation!.point.phase).not.toBe('takeoff')
    const issue = c.issues.find((i) => i.id === 'envelope-cg')
    expect(issue).toBeDefined()
    expect(issue!.phase).toBe('burn:aux')
    expect(issue!.message).toContain('前限')
    expect(issue!.message).toContain('巡航耗油（后部副油箱）')
  })

  it('优先级：重量类问题排在单舱与重心类之前，error 排在 warning 之前', () => {
    // 同时触发：MTOW 超重 + 后舱超限 + 重心越界
    const c = evaluateLoad(aircraft, manifestItems, {
      assignments: rearHeavyAssignments,
      fuel: { aux: 900, main: 2200 },
      burn: 100,
    })
    expect(c.issues.length).toBeGreaterThanOrEqual(3)
    expect(c.issues[0].category).toBe('weight')
    const priorities = c.issues.map((i) => categoryPriority[i.category])
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
    const firstWarning = c.issues.findIndex((i) => i.severity === 'warning')
    const lastError = c.issues.map((i) => i.severity).lastIndexOf('error')
    if (firstWarning !== -1 && lastError !== -1) {
      expect(lastError).toBeLessThan(firstWarning)
    }
  })

  it('预计耗油超过机载燃油时报燃油问题', () => {
    const c = evaluateLoad(aircraft, manifestItems, { ...base, burn: 3000 })
    expect(c.issues.some((i) => i.id === 'fuel-burn' && i.severity === 'error')).toBe(true)
  })

  it('未装载清单给出警告且不计入重量', () => {
    const assignments = { ...defaultAssignments }
    delete assignments.pax01
    const c = evaluateLoad(aircraft, manifestItems, { ...base, assignments })
    const issue = c.issues.find((i) => i.id === 'manifest-unassigned')
    expect(issue).toBeDefined()
    expect(issue!.severity).toBe('warning')
    expect(issue!.contributors.map((x) => x.label)).toContain('王建国')
    expect(c.zfw.weight).toBe(6737 - 185)
  })
})
