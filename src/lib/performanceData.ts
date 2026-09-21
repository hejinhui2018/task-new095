/**
 * 跑道性能放行数据：机场/跑道道面数据 + 机型版本化性能表。
 * 全部数据为虚构，仅用于演示。
 *
 * 性能表约定（见 performance.ts）：
 * - groundRun / landing：给定（气压高度、气温、重量）下的所需距离（ft）；
 * - climbAllEngines / climbOneEngine：给定（气压高度、气温、重量）下的总梯度（%）。
 * 高度轴与温度轴必须严格升序，且查询落在轴覆盖范围之外时拒绝（不做外推）。
 */

export type SurfaceState = 'dry' | 'wet'

export interface RunwayEnd {
  /** 跑道端编号，如 '09' */
  designator: string
  /** 磁方位角（度），用于风向分解 */
  heading: number
  /** 相对跑道入口的起飞滑跑可用距离（ft） */
  tora: number
  /** 越障终点高度（ft）；0 表示无障碍物 */
  obstacleHeight: number
  /** 从起飞滑跑起点到障碍物的水平距离（ft）；无障碍物时为 0 */
  obstacleDistance: number
}

export interface Runway {
  id: string
  /** 跑道名，如 '09/27' */
  name: string
  /** 两个使用方向；道面长度共用，各自的 TORA / 障碍物可能不同 */
  ends: [RunwayEnd, RunwayEnd]
  /** 平均坡度（%）：沿第一个端方向上坡为正 */
  slope: number
  surface: 'asphalt' | 'concrete' | 'gravel'
}

export interface Airport {
  id: string
  name: string
  /** 机场标高（ft MSL），仅用于展示；查询使用用户输入的气压高度 */
  elevation: number
  runways: Runway[]
}

/** 三维性能表：轴为气压高度（ft）、气温（°C）、重量（lb） */
export interface PerformanceTable {
  /** 气压高度断点（严格升序） */
  altitudes: number[]
  /** 气温断点（严格升序） */
  temperatures: number[]
  /** 重量断点（严格升序） */
  weights: number[]
  /**
   * 数值按 [altitudeIndex][temperatureIndex][weightIndex] 排列。
   * 距离表单位 ft，梯度表单位 %。null 表示该组合无审定数据（必须拒绝）。
   */
  values: (number | null)[][][]
}

export type PerformanceKind =
  | 'groundRun'
  | 'climbAllEngines'
  | 'climbOneEngine'
  | 'landing'

/** 机型性能数据集（版本化） */
export interface AircraftPerformance {
  /** 机型 id，对应 Aircraft.id */
  aircraftId: string
  /** 性能表版本，界面与放行结论中展示 */
  version: string
  tables: Record<PerformanceKind, PerformanceTable>
  /** 修正规则（按 wind → slope → surface 的顺序应用，详见 performance.ts） */
  corrections: PerformanceCorrections
}

export interface PerformanceCorrections {
  /** 风：距离每节修正百分比（正值=逆风减距，顺风加距） */
  windDistancePerKnot: number
  /** 风：顺风风速允许上限（kt，含边界）；超过必须拒绝 */
  maxTailwindKnot: number
  /** 坡度：距离每 1% 坡度修正百分比（上坡增长距离） */
  slopeDistancePerPercent: number
  /** 湿道面对滑跑距离的乘数（仅 dry→wet） */
  wetGroundRunFactor: number
  /** 湿道面对着陆距离的乘数 */
  wetLandingFactor: number
  /** 湿跑道单发越障最大允许重量 = 干跑道值 × 此折减系数 */
  wetOneEngineWeightFactor: number
}

/**
 * 虚构机场「云川」：Z09/27 为短湿跑道示例，Z15/33 为较长跑道（供换跑道候选）。
 */
export const airports: Airport[] = [
  {
    id: 'YZC',
    name: '云川机场（虚构）',
    elevation: 2040,
    runways: [
      {
        id: 'rwy09',
        name: '09/27',
        slope: 1.2,
        surface: 'asphalt',
        ends: [
          { designator: '09', heading: 90, tora: 3400, obstacleHeight: 24, obstacleDistance: 1500 },
          { designator: '27', heading: 270, tora: 3400, obstacleHeight: 0, obstacleDistance: 0 },
        ],
      },
      {
        id: 'rwy15',
        name: '15/33',
        slope: -0.4,
        surface: 'concrete',
        ends: [
          { designator: '15', heading: 150, tora: 5200, obstacleHeight: 30, obstacleDistance: 2600 },
          { designator: '33', heading: 330, tora: 5200, obstacleHeight: 0, obstacleDistance: 0 },
        ],
      },
    ],
  },
]

// ---- 性能表轴 ----
const ALT = [0, 2000, 4000, 6000]
const TEMP = [-10, 10, 30, 40]
const W = [5500, 6500, 7500, 8500, 8750]

/** 生成随高度/温度/重量单调增长的距离表（虚构基线） */
function distanceTable(base: number, perAlt: number, perTemp: number, perWeight: number) {
  return ALT.map((a, ai) =>
    TEMP.map((t, ti) =>
      W.map((w, wi) => {
        // (8750 lb, 4000 ft 以上, 40°C) 的右上角组合无审定数据
        if (wi === W.length - 1 && ai >= 2 && ti === TEMP.length - 1) return null
        return Math.round(
          base + (a / 1000) * perAlt + (t + 10) * perTemp + (w - 5500) * perWeight,
        )
      }),
    ),
  )
}

/** 生成随高度/温度/重量单调下降的总梯度表（%）；高×热×重组合可标注无数据 */
function gradientTable(
  base: number,
  perAlt: number,
  perTemp: number,
  perWeight: number,
  makeHole: boolean,
) {
  return ALT.map((a, ai) =>
    TEMP.map((t, ti) =>
      W.map((w, wi) => {
        // 单发梯度：高 × 热 × 重的三个组合无审定数据
        if (makeHole && ai >= 2 && ti >= 3 && wi >= 3) return null
        const g = base - (a / 1000) * perAlt - (t + 10) * perTemp - (w - 5500) * perWeight
        return Math.round(g * 100) / 100
      }),
    ),
  )
}

/**
 * K-12 虚构性能表（K12-PERF-A1）：
 * - groundRun 起飞滑跑距离基线约 1200 ft；
 * - climbAllEngines 全发总梯度基线约 8.0%；
 * - climbOneEngine 单发总梯度基线约 2.4%；
 * - landing 着陆距离基线约 950 ft。
 */
export const k12Performance: AircraftPerformance = {
  aircraftId: 'K12',
  version: 'K12-PERF-A1',
  corrections: {
    windDistancePerKnot: 0.009,
    maxTailwindKnot: 10,
    slopeDistancePerPercent: 0.05,
    wetGroundRunFactor: 1.15,
    wetLandingFactor: 1.15,
    wetOneEngineWeightFactor: 0.94,
  },
  tables: {
    groundRun: {
      altitudes: [...ALT],
      temperatures: [...TEMP],
      weights: [...W],
      values: distanceTable(1200, 90, 6, 0.34),
    },
    climbAllEngines: {
      altitudes: [...ALT],
      temperatures: [...TEMP],
      weights: [...W],
      values: gradientTable(8.0, 0.35, 0.045, 0.0011, false),
    },
    climbOneEngine: {
      altitudes: [...ALT],
      temperatures: [...TEMP],
      weights: [...W],
      // 校准后：2040ft/28°C 下 8750lb 仍有 1.65%（干跑道对 1.60% 越障不构成表约束）
      values: gradientTable(2.4, 0.08, 0.006, 0.00011, true),
    },
    landing: {
      altitudes: [...ALT],
      temperatures: [...TEMP],
      weights: [...W],
      values: distanceTable(950, 75, 5, 0.28),
    },
  },
}

export function getAirport(id: string): Airport | undefined {
  return airports.find((a) => a.id === id)
}

export function getRunway(airport: Airport, runwayId: string): Runway | undefined {
  return airport.runways.find((r) => r.id === runwayId)
}
