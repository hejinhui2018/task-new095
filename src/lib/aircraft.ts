import type { Aircraft } from './types'

/**
 * 虚构机型「云雀 K-12」：12 座通勤飞机。
 * 空机重量含机组、标配设备与不可用油。
 * 注意 fuelTanks 的顺序即耗油顺序：后部副油箱先耗，机翼主油箱后耗，
 * 因此耗油过程中重心先前移、后小幅后移，轨迹呈折线。
 */
export const aircraft: Aircraft = {
  id: 'K12',
  name: '云雀 K-12',
  description: '虚构 12 座通勤飞机（空机重量含机组、标配设备与不可用油）',
  emptyWeight: 4500,
  emptyArm: 160,
  mtow: 8750,
  mlw: 8500,
  mzfw: 7300,
  rows: [
    { id: 'row1', name: '第 1 排', arm: 125, seats: ['1A', '1B', '1C', '1D'] },
    { id: 'row2', name: '第 2 排', arm: 160, seats: ['2A', '2B', '2C', '2D'] },
    { id: 'row3', name: '第 3 排', arm: 195, seats: ['3A', '3B', '3C', '3D'] },
  ],
  baggageCompartments: [
    { id: 'bagFwd', name: '前行李舱', arm: 50, maxWeight: 500, position: 'forward' },
    { id: 'bagAft', name: '后行李舱', arm: 235, maxWeight: 450, position: 'aft' },
  ],
  fuelTanks: [
    { id: 'aux', name: '后部副油箱', arm: 192, capacity: 900 },
    { id: 'main', name: '机翼主油箱', arm: 155, capacity: 2200 },
  ],
  envelope: [
    { weight: 4500, forwardArm: 151, aftArm: 173 },
    { weight: 6200, forwardArm: 150, aftArm: 174 },
    { weight: 7500, forwardArm: 149, aftArm: 171.5 },
    { weight: 8750, forwardArm: 148, aftArm: 168.5 },
  ],
}
