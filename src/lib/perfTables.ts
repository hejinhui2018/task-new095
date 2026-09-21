/**
 * 云雀 K-12 虚构飞行手册（AFM）性能表 —— 全部数据为虚构，仅用于演示。
 *
 * 版本：K12-AFM-2026.1。表结构与数值变更必须升版本号；
 * 所有表格均为闭式网格，查询只允许在标注范围内严格插值，禁止外推。
 *
 * 表 1/2：起飞滑跑（TOD）与着陆滑跑（LD）所需距离（ft，干道面/静风/平坡基准），
 *         以气压高度 PA × 外界温度 OAT × 重量 索引。
 * 表 3/4：全发越障 / 单发停车（OEI）净航迹允许的最大重量（lb），以 PA × OAT 索引；
 *         null 单元格表示该高温/高原组合无经批准数据。
 * 表 5  ：越障额外梯度 → 限重扣减（全发 / 单发各一列），末段 null 表示无法越障。
 */

export const PERF_TABLE_VERSION = 'K12-AFM-2026.1'

/** 距离表重量轴（lb），同时是反解限重的闭式重量范围（低于 6500 不允许反推） */
export const PERF_WEIGHTS = [6500, 7000, 7500, 8000, 8500, 8750] as const
/** 气压高度轴（ft MSL） */
export const PERF_PA = [0, 2000, 4000, 6000, 8000] as const
/** 外界温度轴（°C） */
export const PERF_OAT = [-10, 10, 30, 40] as const

/** 起飞滑跑基准距离（ft，PA=0、OAT=15°C、干、静风、平坡），按 PERF_WEIGHTS */
const TOD_BASE = [1850, 2100, 2400, 2780, 3250, 3550]
/** 着陆滑跑基准距离（ft，PA=0、OAT=15°C、干、静风、平坡） */
const LD_BASE = [1450, 1620, 1820, 2050, 2300, 2450]

/** 起飞距离的气压高度倍数（密度高度影响，发动机推力与空速） */
const TOD_PA_MULT = [1.0, 1.13, 1.28, 1.45, 1.65]
/** 着陆距离的气压高度倍数（着陆真空速增大） */
const LD_PA_MULT = [1.0, 1.06, 1.13, 1.21, 1.3]

/** ISA 温度随高度递减（°C）：15 − 1.981·PA/1000 */
export function isaTemp(pa: number): number {
  return 15 - 1.981 * (pa / 1000)
}

/** 起飞：每高于 ISA 1°C，距离增加 0.8% */
const TOD_TEMP_PER_C = 0.008
/** 着陆：每高于 ISA 1°C，距离增加 0.4% */
const LD_TEMP_PER_C = 0.004

const round10 = (n: number) => Math.round(n / 10) * 10

function buildDistanceTable(base: number[], paMult: number[], perC: number): number[] {
  const out: number[] = []
  for (let ix = 0; ix < PERF_PA.length; ix++) {
    for (let iy = 0; iy < PERF_OAT.length; iy++) {
      for (let iw = 0; iw < PERF_WEIGHTS.length; iw++) {
        const d =
          base[iw] * paMult[ix] * (1 + perC * (PERF_OAT[iy] - isaTemp(PERF_PA[ix])))
        out.push(round10(d))
      }
    }
  }
  return out
}

/**
 * 起飞滑跑所需距离表。
 * 网格索引：data[(ipa * OAT.length + ioat) * WEIGHTS.length + iw]
 */
export const todDistanceTable: readonly number[] = buildDistanceTable(
  TOD_BASE,
  TOD_PA_MULT,
  TOD_TEMP_PER_C,
)
/** 着陆滑跑所需距离表，索引方式同上 */
export const landingDistanceTable: readonly number[] = buildDistanceTable(
  LD_BASE,
  LD_PA_MULT,
  LD_TEMP_PER_C,
)

/**
 * 全发越障限重表（lb），data[ipa * OAT.length + ioat]。
 * 高温/高原角为 null：无经批准的全发净航迹数据。
 */
export const allEngineClimbTable: readonly (number | null)[] = [
  // PA=0
  9400, 9300, 9100, 8850,
  // PA=2000
  9150, 9000, 8750, 8450,
  // PA=4000
  8850, 8650, 8350, 8000,
  // PA=6000
  8550, 8250, 7850, 7450,
  // PA=8000
  8200, 7900, 7450, null,
]

/**
 * 单发停车越障限重表（lb），索引同上；null 角更大（单发性能严苛）。
 */
export const oeiClimbTable: readonly (number | null)[] = [
  // PA=0
  9050, 8950, 8750, 8500,
  // PA=2000
  8800, 8650, 8400, 8100,
  // PA=4000
  8500, 8300, 8000, 7600,
  // PA=6000
  8150, 7900, 7500, null,
  // PA=8000
  7750, 7450, null, null,
]

/** 越障额外梯度轴（%）：障碍物相对跑道端的净梯度要求减去 35 ft 屏隐高基准 */
export const OBST_GRADIENT = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0] as const
/** 全发越障限重扣减（lb），与 OBST_GRADIENT 对应；null = 无法越障 */
export const OBST_PENALTY_ALL = [0, 90, 200, 330, 480, 650, null]
/** 单发越障限重扣减（lb）；2.5% 以上无批准数据 */
export const OBST_PENALTY_OEI = [0, 150, 330, 540, 780, null, null]

// ---- 修正量的适用边界（超出必须拒绝，不能外推） ----

/** 起飞/着陆距离修正允许的最大顶风分量（kt） */
export const MAX_HEADWIND_KT = 40
/** 允许的最大顺风分量（kt） */
export const MAX_TAILWIND_KT = 10
/** 经验证的最大侧风分量（kt，含干湿道面） */
export const MAX_CROSSWIND_KT = 22
/** 坡度表适用范围（%，正=上坡） */
export const SLOPE_RANGE_PCT = 2.0
/** 湿道面运行的温度/高度批准范围（超出 = 无湿跑道数据，拒绝） */
export const WET_MAX_OAT = 35
export const WET_MAX_PA = 6000

// ---- 修正系数（按规定顺序：风 → 坡度 → 道面） ----

/** 起飞：顶风每 kt 减少 1.0% 所需距离 */
export const TOD_HEADWIND_PER_KT = 0.01
/** 起飞：顺风每 kt 增加 5.0% 所需距离 */
export const TOD_TAILWIND_PER_KT = 0.05
/** 起飞：上坡每 1% 增加 7%，下坡每 1% 减少 7% */
export const TOD_SLOPE_PER_PCT = 0.07
/** 起飞湿道面系数（干 = 1） */
export const TOD_WET_FACTOR = 1.15

/** 着陆：顶风每 kt 减少 0.6%，顺风每 kt 增加 3.0% */
export const LD_HEADWIND_PER_KT = 0.006
export const LD_TAILWIND_PER_KT = 0.03
/** 着陆：上坡（反向进场即下坡着陆）每 1% 减少 5%，下坡增加 5% */
export const LD_SLOPE_PER_PCT = 0.05
/** 着陆湿道面系数 */
export const LD_WET_FACTOR = 1.15

/** 起飞屏隐高（ft）：越障梯度从越过 35 ft 后起算 */
export const TAKEOFF_SCREEN_FT = 35
