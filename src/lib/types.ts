/** 领域模型类型定义。重量单位 lb，力臂单位 in（距基准面），力矩单位 lb·in。 */

export interface SeatRow {
  id: string
  name: string
  /** 该排座位的力臂 */
  arm: number
  /** 座位号（站位 id），如 '1A' */
  seats: string[]
}

export interface BaggageCompartment {
  id: string
  name: string
  arm: number
  maxWeight: number
  position: 'forward' | 'aft'
}

export interface FuelTank {
  id: string
  name: string
  arm: number
  capacity: number
}

/** 重量—重心包线节点：某一重量下的前限与后限（力臂） */
export interface EnvelopePoint {
  weight: number
  forwardArm: number
  aftArm: number
}

export interface Aircraft {
  id: string
  name: string
  description: string
  emptyWeight: number
  emptyArm: number
  /** 最大起飞重量 */
  mtow: number
  /** 最大落地重量 */
  mlw: number
  /** 最大零油重量 */
  mzfw: number
  rows: SeatRow[]
  baggageCompartments: BaggageCompartment[]
  /** 按耗油顺序排列：数组靠前的油箱先耗 */
  fuelTanks: FuelTank[]
  /** 按重量升序排列的包线节点 */
  envelope: EnvelopePoint[]
}

export type ItemKind = 'pax' | 'bag'

export interface LoadItem {
  id: string
  kind: ItemKind
  name: string
  weight: number
}

export type StationKind = 'seat' | 'baggage'

/** 可放置载荷的站位（座位或行李舱） */
export interface StationInfo {
  id: string
  name: string
  arm: number
  kind: StationKind
}
