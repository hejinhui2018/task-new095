/**
 * 跑道性能放行计算。
 *
 * 流程（严格按顺序）：
 *  1. 解析机场/跑道/方向，得到坡度与障碍物的生效值（库值或人工覆盖）；
 *  2. 表界检查：气压高度、温度必须落在性能表标注范围内 —— 超出拒绝，不外推；
 *  3. 风分解为顺/顶/侧风分量，顺逆风、侧风超界拒绝；坡度超界拒绝；
 *     湿道面超出批准的温度/高度范围拒绝；
 *  4. 表内基准距离按 (气压高度, 温度) 双线性插值，得到距离—重量曲线；
 *  5. 修正按「风 → 坡度 → 道面」的规定顺序逐项乘到所需距离上；
 *  6. 以可用距离（TORA/LDA）反解最大重量：只允许在表注重量范围内插值，
 *     修正后连表中最轻重量都超出可用距离 → 拒绝（不夹到边界伪装有效）；
 *  7. 越障限重 = (PA,OAT) 插值得到的爬升限重 − 越障额外梯度扣减表（一维严格插值，
 *     表中 null / 超出末档 = 无数据，拒绝）；
 *  8. 起飞限重取 滑跑 / 全发越障 / 单发越障 三者最小，再与结构 MTOW 比较确定控制阶段。
 */

import type { Aircraft } from './types'
import { findAirport, findRunwayEnd, type Obstacle, type Runway, type RunwayEnd, type SurfaceCondition } from './airports'
import { bilinearStrict, linearStrict, type Grid2D, type OutOfRange } from './interpolate'
import {
  LD_HEADWIND_PER_KT,
  LD_SLOPE_PER_PCT,
  LD_TAILWIND_PER_KT,
  LD_WET_FACTOR,
  MAX_CROSSWIND_KT,
  MAX_HEADWIND_KT,
  MAX_TAILWIND_KT,
  OBST_GRADIENT,
  OBST_PENALTY_ALL,
  OBST_PENALTY_OEI,
  PERF_OAT,
  PERF_PA,
  PERF_TABLE_VERSION,
  PERF_WEIGHTS,
  SLOPE_RANGE_PCT,
  TAKEOFF_SCREEN_FT,
  TOD_HEADWIND_PER_KT,
  TOD_SLOPE_PER_PCT,
  TOD_TAILWIND_PER_KT,
  TOD_WET_FACTOR,
  WET_MAX_OAT,
  WET_MAX_PA,
  allEngineClimbTable,
  landingDistanceTable,
  oeiClimbTable,
  todDistanceTable,
} from './perfTables'

export type PerfStage = 'tod' | 'climb-all' | 'climb-oei' | 'landing'

export const STAGE_LABELS: Record<PerfStage, string> = {
  tod: '起飞滑跑',
  'climb-all': '全发越障',
  'climb-oei': '单发越障',
  landing: '着陆距离',
}

/** 跑道性能输入（风为气象观测人工输入；坡度/障碍物可为空 = 采用跑道库值） */
export interface PerfInput {
  airportId: string
  runwayId: string
  endId: string
  surface: SurfaceCondition
  oatC: number
  pressureAltFt: number
  /** 风向（来风方向，°磁） */
  windDirDeg: number
  windSpeedKt: number
  slopeOverridePct: number | null
  obstacleOverride: Obstacle | null
}

export type RejectCode =
  | 'unknown-airport'
  | 'unknown-runway'
  | 'pa-out-of-range'
  | 'oat-out-of-range'
  | 'wet-not-approved'
  | 'wind-headwind'
  | 'wind-tailwind'
  | 'wind-crosswind'
  | 'slope-out-of-range'
  | 'climb-no-data'
  | 'obstacle-no-data'
  | 'field-below-table'

export interface ValueSource<T> {
  value: T
  source: 'library' | 'user'
  libraryValue: T
}

export interface WindComponents {
  /** 正 = 顶风，负 = 顺风 */
  headwindKt: number
  crosswindKt: number
  crossSide: 'left' | 'right'
}

export interface CorrectionStep {
  label: string
  /** 本步系数 */
  factor: number
  /** 截至本步的累积系数 */
  cumulative: number
}

export type StageResult =
  | {
      stage: PerfStage
      status: 'ok'
      /** 性能表给出的限重（未经结构封顶） */
      perfLimitLb: number
      /** 结构封顶（MTOW / MLW） */
      structuralCapLb: number
      /** 生效限重 = min(性能限重, 结构限重) */
      effectiveLimitLb: number
      actualLb: number
      marginLb: number
      correctionTrace: CorrectionStep[]
      basis: string
      requiredDistanceFt: number | null
      availableDistanceFt: number | null
    }
  | {
      stage: PerfStage
      status: 'rejected'
      code: RejectCode
      message: string
      correctionTrace: CorrectionStep[]
    }

export interface ResolvedPerf {
  airport: NonNullable<ReturnType<typeof findAirport>>
  runway: Runway
  end: RunwayEnd
  surface: SurfaceCondition
  oatC: number
  pressureAltFt: number
  airportElevationFt: number
  windDirDeg: number
  windSpeedKt: number
  wind: WindComponents
  slope: ValueSource<number>
  obstacle: ValueSource<Obstacle>
  /** 障碍物相对屏隐高的额外净梯度（%） */
  obstacleGradientPct: number
}

export interface ControllingStage {
  stage: PerfStage | 'mtow' | 'mlw'
  effectiveLimitLb: number
}

export interface PerformanceReport {
  version: string
  resolved: ResolvedPerf | null
  stages: Record<PerfStage, StageResult>
  /** 任一起飞阶段被拒绝时为 null */
  controllingTakeoff: ControllingStage | null
  controllingLanding: ControllingStage | null
  takeoffOk: boolean
  landingOk: boolean
  rejections: Extract<StageResult, { status: 'rejected' }>[]
}

const floor10 = (n: number) => Math.floor(n / 10) * 10

/** 风分解：按运行方向（跑道端磁航向）算顶/顺与侧风分量 */
export function decomposeWind(headingDeg: number, windDirDeg: number, speedKt: number): WindComponents {
  const rad = ((headingDeg - windDirDeg) * Math.PI) / 180
  const hw = speedKt * Math.cos(rad)
  const x = speedKt * Math.sin(rad)
  return {
    headwindKt: hw,
    crosswindKt: Math.abs(x),
    // 从运行方向看：sin(heading−windDir)>0 表示风从右侧来
    crossSide: x >= 0 ? 'right' : 'left',
  }
}

/** 障碍物超出屏隐高的额外净梯度（%）；不高于屏隐高时为 0 */
export function obstacleGradient(obstacle: Obstacle): number {
  if (!(obstacle.distanceFt > 0)) return 0
  const excess = obstacle.heightFt - TAKEOFF_SCREEN_FT
  if (excess <= 0) return 0
  return (excess / obstacle.distanceFt) * 100
}

/** 取距离表中某一重量切片、按 (PA,OAT) 索引的二维网格 */
function distanceSliceAtWeight(table: readonly number[], iw: number): Grid2D {
  const data: number[] = []
  for (let ipa = 0; ipa < PERF_PA.length; ipa++) {
    for (let ioat = 0; ioat < PERF_OAT.length; ioat++) {
      data.push(table[(ipa * PERF_OAT.length + ioat) * PERF_WEIGHTS.length + iw])
    }
  }
  return {
    x: { name: '气压高度', nodes: [...PERF_PA] },
    y: { name: '温度', nodes: [...PERF_OAT] },
    data,
  }
}

function climbGrid(data: readonly (number | null)[]): Grid2D {
  return {
    x: { name: '气压高度', nodes: [...PERF_PA] },
    y: { name: '温度', nodes: [...PERF_OAT] },
    data: [...data],
  }
}

/** 表界/无数据拒绝原因的中文说明 */
function rangeMessage(prefix: string, r: OutOfRange): string {
  switch (r.code) {
    case 'below-min':
      return `${prefix}低于性能表标注下限 ${r.bound}（输入 ${fmt1(r.actual)}），禁止外推`
    case 'above-max':
      return `${prefix}高于性能表标注上限 ${r.bound}（输入 ${fmt1(r.actual)}），禁止外推`
    case 'null-cell':
      return `${prefix}所在的表格区域无经批准数据（空单元格），拒绝放行`
    default:
      return `${prefix}超出性能表范围`
  }
}

const fmt1 = (n: number | undefined): string => (n === undefined ? '—' : Math.round(n * 10) / 10 + '')

/**
 * 距离—重量曲线：在 (pa, oat) 处对每个表注重量双线性插值基准距离。
 * 任一切片插值失败（超界/空单元格）即整体失败。
 */
function distanceCurve(table: readonly number[], pa: number, oat: number): number[] | OutOfRange {
  const curve: number[] = []
  for (let iw = 0; iw < PERF_WEIGHTS.length; iw++) {
    const r = bilinearStrict(distanceSliceAtWeight(table, iw), pa, oat)
    if (!r.ok) return r.reason
    curve.push(r.value)
  }
  return curve
}

/**
 * 以可用距离反解限重：曲线在重量轴上严格单调（构造保证），只在表注重量范围内线性插值。
 * 可用距离连最轻一档都不够 → null（调用方按 field-below-table 拒绝）；
 * 最重一档仍够 → 返回表注上限（交由结构重量封顶）。
 */
function weightForDistance(curve: number[], availableFt: number): number | null {
  if (availableFt < curve[0]) return null
  for (let i = 0; i < curve.length - 1; i++) {
    if (availableFt >= curve[i] && availableFt < curve[i + 1]) {
      const t = (availableFt - curve[i]) / (curve[i + 1] - curve[i])
      return PERF_WEIGHTS[i] + t * (PERF_WEIGHTS[i + 1] - PERF_WEIGHTS[i])
    }
  }
  return PERF_WEIGHTS[PERF_WEIGHTS.length - 1]
}

/** 在重量轴上插值修正后所需距离；超出表注重量范围返回 null（不外推） */
function distanceAtWeight(curve: number[], weight: number): number | null {
  if (weight < PERF_WEIGHTS[0] || weight > PERF_WEIGHTS[PERF_WEIGHTS.length - 1]) return null
  for (let i = 0; i < curve.length - 1; i++) {
    if (weight >= PERF_WEIGHTS[i] && weight <= PERF_WEIGHTS[i + 1]) {
      const t = (weight - PERF_WEIGHTS[i]) / (PERF_WEIGHTS[i + 1] - PERF_WEIGHTS[i])
      return curve[i] + t * (curve[i + 1] - curve[i])
    }
  }
  return curve[curve.length - 1]
}

interface FieldCalc {
  stage: PerfStage
  availableFt: number
  trace: CorrectionStep[]
  perfLimit?: number
  curve?: number[]
  rejected?: { code: RejectCode; message: string }
}

/** 场长阶段（起飞滑跑 / 着陆）共用计算：插值 → 风/坡/面顺序修正 → 反解 */
function fieldLimit(
  stage: PerfStage,
  availableFt: number,
  baseTable: readonly number[],
  pa: number,
  oat: number,
  wind: WindComponents,
  slopePct: number,
  surface: SurfaceCondition,
): FieldCalc {
  const trace: CorrectionStep[] = []
  const curveOrReason = distanceCurve(baseTable, pa, oat)
  if (!Array.isArray(curveOrReason)) {
    return { stage, availableFt, trace, rejected: { code: 'pa-out-of-range', message: rangeMessage(`${STAGE_LABELS[stage]}：`, curveOrReason) } }
  }

  // —— 规定顺序第 1 步：风修正 ——
  const hwPer = stage === 'tod' ? TOD_HEADWIND_PER_KT : LD_HEADWIND_PER_KT
  const twPer = stage === 'tod' ? TOD_TAILWIND_PER_KT : LD_TAILWIND_PER_KT
  let f: number
  let windLabel: string
  if (wind.headwindKt >= 0) {
    f = 1 - hwPer * wind.headwindKt
    windLabel = `风修正：顶风 ${wind.headwindKt.toFixed(1)} kt ×${f.toFixed(3)}`
  } else {
    f = 1 + twPer * -wind.headwindKt
    windLabel = `风修正：顺风 ${(-wind.headwindKt).toFixed(1)} kt ×${f.toFixed(3)}`
  }
  trace.push({ label: windLabel, factor: f, cumulative: f })

  // —— 第 2 步：坡度修正（着陆方向与起飞相同，上坡有助于着陆制动，系数取负号）——
  const slopePer = stage === 'tod' ? TOD_SLOPE_PER_PCT : -LD_SLOPE_PER_PCT
  const fs = 1 + slopePer * slopePct
  f *= fs
  trace.push({
    label: `坡度修正：${slopePct >= 0 ? '上' : '下'}坡 ${Math.abs(slopePct).toFixed(1)}% ×${fs.toFixed(3)}`,
    factor: fs,
    cumulative: f,
  })

  // —— 第 3 步：道面修正（湿）——
  if (surface === 'wet') {
    const fw = stage === 'tod' ? TOD_WET_FACTOR : LD_WET_FACTOR
    f *= fw
    trace.push({ label: `道面修正：湿道面 ×${fw.toFixed(2)}`, factor: fw, cumulative: f })
  } else {
    trace.push({ label: '道面修正：干道面 ×1.00', factor: 1, cumulative: f })
  }

  const corrected = curveOrReason.map((d) => d * f)
  const limit = weightForDistance(corrected, availableFt)

  if (limit === null) {
    return {
      stage,
      availableFt,
      trace,
      curve: corrected,
      rejected: {
        code: 'field-below-table',
        message:
          `${STAGE_LABELS[stage]}：经风/坡度/道面修正后，表注最轻重量 ${PERF_WEIGHTS[0].toLocaleString()} lb ` +
          `所需距离仍超过可用 ${availableFt.toLocaleString()} ft，表格范围内无可用限重，拒绝放行`,
      },
    }
  }
  return { stage, availableFt, trace, perfLimit: limit, curve: corrected }
}

/** 越障阶段：爬升表插值 − 梯度扣减（一维严格插值，null/超界拒绝） */
function climbLimit(
  stage: 'climb-all' | 'climb-oei',
  table: readonly (number | null)[],
  penalties: readonly (number | null)[],
  pa: number,
  oat: number,
  gradientPct: number,
  obstacle: Obstacle,
): { perfLimit?: number; rejected?: { code: RejectCode; message: string }; gradientPct: number } {
  const base = bilinearStrict(climbGrid(table), pa, oat)
  if (!base.ok) {
    return { gradientPct, rejected: { code: 'climb-no-data', message: rangeMessage(`${STAGE_LABELS[stage]}：`, base.reason) } }
  }
  const pen = linearStrict([...OBST_GRADIENT], [...penalties], gradientPct)
  if (!pen.ok) {
    const why =
      pen.reason.code === 'null-cell' || pen.reason.code === 'above-max'
        ? `障碍物净梯度 ${gradientPct.toFixed(2)}%（障碍物 ${obstacle.heightFt} ft / ${obstacle.distanceFt.toLocaleString()} ft）超过${STAGE_LABELS[stage]}表允许范围，无越障数据`
        : rangeMessage('越障梯度', pen.reason)
    return { gradientPct, rejected: { code: 'obstacle-no-data', message: why } }
  }
  return { gradientPct, perfLimit: base.value - pen.value }
}

export interface ActualWeights {
  takeoffLb: number
  landingLb: number
}

function okStage(
  stage: PerfStage,
  perfLimit: number,
  cap: number,
  actualLb: number,
  trace: CorrectionStep[],
  basis: string,
  curve?: number[],
  availableFt?: number,
): StageResult {
  const effectiveLimit = Math.min(floor10(perfLimit), cap)
  const required = curve ? distanceAtWeight(curve, actualLb) : null
  return {
    stage,
    status: 'ok',
    perfLimitLb: floor10(perfLimit),
    structuralCapLb: cap,
    effectiveLimitLb: effectiveLimit,
    actualLb,
    marginLb: effectiveLimit - actualLb,
    correctionTrace: trace,
    basis,
    requiredDistanceFt: required === null ? null : Math.round(required),
    availableDistanceFt: availableFt ?? null,
  }
}

/** 完整跑道性能放行评估 */
export function evaluatePerformance(
  aircraft: Aircraft,
  input: PerfInput,
  actual: ActualWeights,
): PerformanceReport {
  const version = PERF_TABLE_VERSION
  const rejectedStage = (
    stage: PerfStage,
    code: RejectCode,
    message: string,
    correctionTrace: CorrectionStep[] = [],
  ): Extract<StageResult, { status: 'rejected' }> => ({ stage, status: 'rejected', code, message, correctionTrace })

  const airport = findAirport(input.airportId)
  const runway = airport?.runways.find((r) => r.id === input.runwayId)
  const end = airport && runway ? findRunwayEnd(airport, runway.id, input.endId) : undefined

  if (!airport || !runway || !end) {
    const r = rejectedStage('tod', 'unknown-runway', '找不到所选机场/跑道/方向，拒绝放行')
    const stages = {
      tod: r,
      'climb-all': rejectedStage('climb-all', 'unknown-runway', r.message),
      'climb-oei': rejectedStage('climb-oei', 'unknown-runway', r.message),
      landing: rejectedStage('landing', 'unknown-runway', r.message),
    }
    return {
      version,
      resolved: null,
      stages,
      controllingTakeoff: null,
      controllingLanding: null,
      takeoffOk: false,
      landingOk: false,
      rejections: Object.values(stages),
    }
  }

  const wind = decomposeWind(end.heading, input.windDirDeg, Math.max(input.windSpeedKt, 0))
  const slope: ValueSource<number> =
    input.slopeOverridePct === null
      ? { value: end.slopePct, source: 'library', libraryValue: end.slopePct }
      : { value: input.slopeOverridePct, source: 'user', libraryValue: end.slopePct }
  const obstacle: ValueSource<Obstacle> =
    input.obstacleOverride === null
      ? { value: end.defaultObstacle, source: 'library', libraryValue: end.defaultObstacle }
      : { value: input.obstacleOverride, source: 'user', libraryValue: end.defaultObstacle }
  const gradientPct = obstacleGradient(obstacle.value)

  const resolved: ResolvedPerf = {
    airport,
    runway,
    end,
    surface: input.surface,
    oatC: input.oatC,
    pressureAltFt: input.pressureAltFt,
    airportElevationFt: airport.elevationFt,
    windDirDeg: input.windDirDeg,
    windSpeedKt: Math.max(input.windSpeedKt, 0),
    wind,
    slope,
    obstacle,
    obstacleGradientPct: gradientPct,
  }

  // ---- 全局运行边界（任一不满足，相关阶段拒绝，绝不夹到边界）----
  const paOutOf =
    input.pressureAltFt < PERF_PA[0]
      ? `气压高度 ${input.pressureAltFt} ft 低于表注下限 ${PERF_PA[0]} ft，禁止外推`
      : input.pressureAltFt > PERF_PA[PERF_PA.length - 1]
        ? `气压高度 ${input.pressureAltFt} ft 高于表注上限 ${PERF_PA[PERF_PA.length - 1]} ft，禁止外推`
        : null
  const oatOutOf =
    input.oatC < PERF_OAT[0]
      ? `温度 ${input.oatC}°C 低于表注下限 ${PERF_OAT[0]}°C，禁止外推`
      : input.oatC > PERF_OAT[PERF_OAT.length - 1]
        ? `温度 ${input.oatC}°C 高于表注上限 ${PERF_OAT[PERF_OAT.length - 1]}°C，禁止外推`
        : null
  const wetBlocked =
    input.surface === 'wet' && (input.oatC > WET_MAX_OAT || input.pressureAltFt > WET_MAX_PA)
  const wetMsg =
    `湿道面仅批准至 ${WET_MAX_OAT}°C / ${WET_MAX_PA.toLocaleString()} ft，` +
    `当前 ${input.oatC}°C / ${input.pressureAltFt.toLocaleString()} ft 无湿跑道数据，拒绝放行`

  const stages: Partial<Record<PerfStage, StageResult>> = {}
  // 同一阶段可能同时触发多条边界，保留最先判定的根本原因（按检查顺序）
  const rejectFirst = (s: PerfStage, code: RejectCode, message: string) => {
    if (!stages[s]) stages[s] = rejectedStage(s, code, message)
  }
  if (paOutOf) {
    for (const s of ['tod', 'climb-all', 'climb-oei', 'landing'] as PerfStage[]) {
      rejectFirst(s, 'pa-out-of-range', paOutOf)
    }
  }
  if (oatOutOf) {
    for (const s of ['tod', 'climb-all', 'climb-oei', 'landing'] as PerfStage[]) {
      rejectFirst(s, 'oat-out-of-range', oatOutOf)
    }
  }
  if (wetBlocked) {
    for (const s of ['tod', 'climb-all', 'climb-oei', 'landing'] as PerfStage[]) {
      rejectFirst(s, 'wet-not-approved', wetMsg)
    }
  }
  if (wind.headwindKt > MAX_HEADWIND_KT + 1e-9) {
    const msg = `顶风分量 ${wind.headwindKt.toFixed(1)} kt 超过经批准最大顶风 ${MAX_HEADWIND_KT} kt`
    rejectFirst('tod', 'wind-headwind', msg)
    rejectFirst('landing', 'wind-headwind', msg)
  }
  if (-wind.headwindKt > MAX_TAILWIND_KT + 1e-9) {
    const msg = `顺风分量 ${(-wind.headwindKt).toFixed(1)} kt 超过经批准最大顺风 ${MAX_TAILWIND_KT} kt`
    rejectFirst('tod', 'wind-tailwind', msg)
    rejectFirst('landing', 'wind-tailwind', msg)
  }
  if (wind.crosswindKt > MAX_CROSSWIND_KT + 1e-9) {
    const msg =
      `侧风分量 ${wind.crosswindKt.toFixed(1)} kt（${wind.crossSide === 'right' ? '右' : '左'}侧）` +
      `超过经批准最大侧风 ${MAX_CROSSWIND_KT} kt`
    rejectFirst('tod', 'wind-crosswind', msg)
    rejectFirst('landing', 'wind-crosswind', msg)
  }
  if (Math.abs(slope.value) > SLOPE_RANGE_PCT + 1e-9) {
    const msg = `跑道坡度 ${slope.value}% 超出表注适用范围 ±${SLOPE_RANGE_PCT}%，拒绝外推`
    rejectFirst('tod', 'slope-out-of-range', msg)
    rejectFirst('landing', 'slope-out-of-range', msg)
  }

  const tableBlocked = !!(paOutOf || oatOutOf)

  // ---- 四个限重阶段（仅在未被全局边界拒绝时计算）----
  if (!stages.tod) {
    const calc = fieldLimit('tod', end.toraFt, todDistanceTable, input.pressureAltFt, input.oatC, wind, slope.value, input.surface)
    stages.tod = calc.rejected
      ? rejectedStage('tod', calc.rejected.code, calc.rejected.message, calc.trace)
      : okStage('tod', calc.perfLimit!, aircraft.mtow, actual.takeoffLb, calc.trace,
          `TORA ${end.toraFt.toLocaleString()} ft · ${input.surface === 'wet' ? '湿' : '干'}道面`,
          calc.curve, end.toraFt)
  }
  if (!stages.landing) {
    const calc = fieldLimit('landing', end.ldaFt, landingDistanceTable, input.pressureAltFt, input.oatC, wind, slope.value, input.surface)
    stages.landing = calc.rejected
      ? rejectedStage('landing', calc.rejected.code, calc.rejected.message, calc.trace)
      : okStage('landing', calc.perfLimit!, aircraft.mlw, actual.landingLb, calc.trace,
          `LDA ${end.ldaFt.toLocaleString()} ft · ${input.surface === 'wet' ? '湿' : '干'}道面`,
          calc.curve, end.ldaFt)
  }
  if (!stages['climb-all']) {
    if (tableBlocked || wetBlocked) {
      stages['climb-all'] = rejectedStage('climb-all', wetBlocked ? 'wet-not-approved' : 'pa-out-of-range', wetBlocked ? wetMsg : '超出性能表范围')
    } else {
      const calc = climbLimit('climb-all', allEngineClimbTable, OBST_PENALTY_ALL, input.pressureAltFt, input.oatC, gradientPct, obstacle.value)
      stages['climb-all'] = calc.rejected
        ? rejectedStage('climb-all', calc.rejected.code, calc.rejected.message)
        : okStage('climb-all', calc.perfLimit!, aircraft.mtow, actual.takeoffLb, [],
            `越障额外梯度 ${calc.gradientPct.toFixed(2)}%（${obstacle.value.heightFt} ft / ${obstacle.value.distanceFt.toLocaleString()} ft）`)
    }
  }
  if (!stages['climb-oei']) {
    if (tableBlocked || wetBlocked) {
      stages['climb-oei'] = rejectedStage('climb-oei', wetBlocked ? 'wet-not-approved' : 'pa-out-of-range', wetBlocked ? wetMsg : '超出性能表范围')
    } else {
      const calc = climbLimit('climb-oei', oeiClimbTable, OBST_PENALTY_OEI, input.pressureAltFt, input.oatC, gradientPct, obstacle.value)
      stages['climb-oei'] = calc.rejected
        ? rejectedStage('climb-oei', calc.rejected.code, calc.rejected.message)
        : okStage('climb-oei', calc.perfLimit!, aircraft.mtow, actual.takeoffLb, [],
            `单发停车净航迹 · 越障额外梯度 ${calc.gradientPct.toFixed(2)}%`)
    }
  }

  const allStages = stages as Record<PerfStage, StageResult>
  const takeoffStages: PerfStage[] = ['tod', 'climb-all', 'climb-oei']
  const takeoffRejected = takeoffStages.some((s) => allStages[s].status === 'rejected')
  const landingRejected = allStages.landing.status === 'rejected'

  let controllingTakeoff: ControllingStage | null = null
  if (!takeoffRejected) {
    let best: { stage: PerfStage; limit: number } = {
      stage: 'tod',
      limit: (allStages.tod as Extract<StageResult, { status: 'ok' }>).effectiveLimitLb,
    }
    for (const s of ['climb-all', 'climb-oei'] as PerfStage[]) {
      const r = allStages[s] as Extract<StageResult, { status: 'ok' }>
      if (r.effectiveLimitLb < best.limit) best = { stage: s, limit: r.effectiveLimitLb }
    }
    controllingTakeoff =
      aircraft.mtow <= best.limit
        ? { stage: 'mtow', effectiveLimitLb: aircraft.mtow }
        : { stage: best.stage, effectiveLimitLb: best.limit }
  }

  let controllingLanding: ControllingStage | null = null
  if (!landingRejected) {
    const lr = allStages.landing as Extract<StageResult, { status: 'ok' }>
    controllingLanding =
      aircraft.mlw <= lr.effectiveLimitLb
        ? { stage: 'mlw', effectiveLimitLb: aircraft.mlw }
        : { stage: 'landing', effectiveLimitLb: lr.effectiveLimitLb }
  }

  const takeoffOk = !takeoffRejected && actual.takeoffLb <= controllingTakeoff!.effectiveLimitLb
  const landingOk = !landingRejected && actual.landingLb <= controllingLanding!.effectiveLimitLb

  const rejections = (['tod', 'climb-all', 'climb-oei', 'landing'] as PerfStage[])
    .map((s) => allStages[s])
    .filter((r): r is Extract<StageResult, { status: 'rejected' }> => r.status === 'rejected')

  return {
    version,
    resolved,
    stages: allStages,
    controllingTakeoff,
    controllingLanding,
    takeoffOk,
    landingOk,
    rejections,
  }
}
