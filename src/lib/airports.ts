/**
 * 虚构机场与跑道数据库。
 * 每条跑道按使用方向（端）给出：磁航向、起飞可用距离 TORA、着陆可用距离 LDA、
 * 运行方向坡度（正=上坡）、默认障碍物（起飞端之外，高 ft / 距跑道端 ft）。
 * 库值是性能输入的默认来源，用户可在表单中覆盖（覆盖后标注「人工输入」并可一键恢复库值）。
 */

export type SurfaceCondition = 'dry' | 'wet'

/** 障碍物：高出跑道端标高的高度，以及距起飞端的水平距离 */
export interface Obstacle {
  heightFt: number
  distanceFt: number
}

export interface RunwayEnd {
  /** 方向号，如 '17' */
  id: string
  /** 磁航向 ° */
  heading: number
  toraFt: number
  ldaFt: number
  /** 该运行方向的坡度（%），正为上坡（起飞增速减慢/着陆反向） */
  slopePct: number
  /** 该方向默认障碍物；heightFt ≤ 35（屏隐高）视为无显著障碍物 */
  defaultObstacle: Obstacle
}

export interface Runway {
  id: string
  /** 如 '17/35' */
  name: string
  ends: RunwayEnd[]
}

export interface Airport {
  id: string
  name: string
  /** 机场标高 ft（气压高度输入的库值来源） */
  elevationFt: number
  runways: Runway[]
}

export const airports: Airport[] = [
  {
    id: 'ZLBS',
    name: '白山支线机场（虚构）',
    elevationFt: 2050,
    runways: [
      {
        id: 'rwy17',
        name: '17/35',
        ends: [
          {
            id: '17',
            heading: 170,
            toraFt: 4000,
            ldaFt: 3850,
            slopePct: 0.8,
            defaultObstacle: { heightFt: 75, distanceFt: 3200 },
          },
          {
            id: '35',
            heading: 350,
            toraFt: 4000,
            ldaFt: 3850,
            slopePct: -0.8,
            defaultObstacle: { heightFt: 30, distanceFt: 2600 },
          },
        ],
      },
      {
        id: 'rwy08',
        name: '08/26',
        ends: [
          {
            id: '08',
            heading: 80,
            toraFt: 5600,
            ldaFt: 5500,
            slopePct: 0,
            defaultObstacle: { heightFt: 25, distanceFt: 3000 },
          },
          {
            id: '26',
            heading: 260,
            toraFt: 5600,
            ldaFt: 5500,
            slopePct: 0,
            defaultObstacle: { heightFt: 25, distanceFt: 3000 },
          },
        ],
      },
    ],
  },
  {
    id: 'ZYCC',
    name: '云川高原机场（虚构）',
    elevationFt: 4520,
    runways: [
      {
        id: 'rwy02',
        name: '02/20',
        ends: [
          {
            id: '02',
            heading: 20,
            toraFt: 6200,
            ldaFt: 6100,
            slopePct: 0.3,
            defaultObstacle: { heightFt: 120, distanceFt: 4000 },
          },
          {
            id: '20',
            heading: 200,
            toraFt: 6200,
            ldaFt: 6100,
            slopePct: -0.3,
            defaultObstacle: { heightFt: 40, distanceFt: 3500 },
          },
        ],
      },
    ],
  },
  {
    id: 'ZPBS',
    name: '坪北机场（虚构）',
    elevationFt: 780,
    runways: [
      {
        id: 'rwy12',
        name: '12/30',
        ends: [
          {
            id: '12',
            heading: 120,
            toraFt: 7100,
            ldaFt: 7000,
            slopePct: 0,
            defaultObstacle: { heightFt: 20, distanceFt: 4000 },
          },
          {
            id: '30',
            heading: 300,
            toraFt: 7100,
            ldaFt: 7000,
            slopePct: 0,
            defaultObstacle: { heightFt: 20, distanceFt: 4000 },
          },
        ],
      },
    ],
  },
]

export function findAirport(id: string): Airport | undefined {
  return airports.find((a) => a.id === id)
}

export function findRunwayEnd(
  airport: Airport,
  runwayId: string,
  endId: string,
): RunwayEnd | undefined {
  return airport.runways.find((r) => r.id === runwayId)?.ends.find((e) => e.id === endId)
}
