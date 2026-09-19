import type { LoadItem } from './types'

/** 初始航班清单：10 名乘客 + 7 件行李 */
export const manifestItems: LoadItem[] = [
  { id: 'pax01', kind: 'pax', name: '王建国', weight: 185 },
  { id: 'pax02', kind: 'pax', name: '李秀英', weight: 142 },
  { id: 'pax03', kind: 'pax', name: '张伟', weight: 176 },
  { id: 'pax04', kind: 'pax', name: '刘洋', weight: 168 },
  { id: 'pax05', kind: 'pax', name: '陈静', weight: 135 },
  { id: 'pax06', kind: 'pax', name: '杨帆', weight: 201 },
  { id: 'pax07', kind: 'pax', name: '赵磊', weight: 189 },
  { id: 'pax08', kind: 'pax', name: '黄敏', weight: 148 },
  { id: 'pax09', kind: 'pax', name: '周涛', weight: 174 },
  { id: 'pax10', kind: 'pax', name: '吴倩', weight: 126 },
  { id: 'bag01', kind: 'bag', name: '登山包', weight: 68 },
  { id: 'bag02', kind: 'bag', name: '行李箱', weight: 55 },
  { id: 'bag03', kind: 'bag', name: '工具箱', weight: 92 },
  { id: 'bag04', kind: 'bag', name: '样品箱', weight: 74 },
  { id: 'bag05', kind: 'bag', name: '邮袋', weight: 88 },
  { id: 'bag06', kind: 'bag', name: '设备箱', weight: 120 },
  { id: 'bag07', kind: 'bag', name: '行李袋', weight: 96 },
]

/** 初始座位/舱位分配（itemId -> 站位 id） */
export const defaultAssignments: Record<string, string> = {
  pax01: '1A',
  pax02: '1B',
  pax03: '1C',
  pax04: '2A',
  pax05: '2B',
  pax06: '2C',
  pax07: '2D',
  pax08: '3A',
  pax09: '3B',
  pax10: '3C',
  bag01: 'bagFwd',
  bag02: 'bagFwd',
  bag03: 'bagFwd',
  bag04: 'bagFwd',
  bag05: 'bagAft',
  bag06: 'bagAft',
  bag07: 'bagAft',
}

/** 初始机载燃油（lb） */
export const defaultFuel: Record<string, number> = { aux: 500, main: 1450 }

/** 初始预计航程耗油（lb） */
export const defaultBurn = 1100
