/**
 * 跑道性能放行：按内置版本化性能表，对给定跑道/大气/风/坡度/道面/障碍物条件，
 * 分别计算四个阶段的限重，并给出控制阶段、裕量、拒绝原因与输入来源链。
 *
 * 规定修正顺序（严禁调换，因为各修正在审定表中的叠加方式不同）：
 *   1. 风（headwind/tailwind，沿跑道方位分解）
 *   2. 坡度（跑道纵向坡度）
 *   3. 道面（干/湿）
 * 距离类限重通过「把可用距离按修正逆序还原成表列当量距离」后反解重量；
 * 单发越障限重在湿道面下按系数折减；任何阶段无数据/超界都明确拒绝，绝不外推。
 */
import type { Aircraft } from './types'
import {
  getAirport,
  getRunway,
  k12Performance,
  type AircraftPerformance,
  type PerformanceKind,
  type Runway,
  type RunwayEnd,
  type SurfaceState,
} from './performanceData'
import { interpolate3, invertWeightAtLimit, type LookupError } from './interp'

/** 跑道放行输入（随方案持久化） */
export interface PerfInput {
  airportId: string
  runwayId: string
  /** 使用方向：跑道端在 ends 数组中的下标 0 / 1 */
  endIndex: 0 | 1
  temperature: number
  pressureAltitude: number
  /** 风速节（kt，非负） */
  windSpeed: number
  /** 风向（度，磁方位，风的来向）；无风时可为 0 */
  windDirection: number
  /** 道面干湿状态 */
  surface: SurfaceState
}

export type PhaseId = 'groundRun' | 'climbAllEngines' | 'climbOneEngine' | 'landing'

export const phaseOrder: PhaseId[] = [
  'groundRun',
  'climbAllEngines',
  'climbOneEngine',
  'landing',
]

export const phaseNames: Record<PhaseId, string> = {
  groundRun: '起飞滑跑',
  climbAllEngines: '全发越障',
  climbOneEngine: '单发越障',
  landing: '着陆距离',
}

/** 起飞相关三阶段（着陆限重单独计算，不与起飞限重混淆） */
const TAKEOFF_PHASE_IDS: PhaseId[] = ['groundRun', 'climbAllEngines', 'climbOneEngine']

/** 单个修正/数据步骤的来源记录（输入来源链） */
export interface SourceStep {
  label: string
  detail: string
}

export type PhaseStatus = 'limited' | 'not-limiting' | 'rejected'

export interface PhaseResult {
  phase: PhaseId
  name: string
  status: PhaseStatus
  /** 该阶段最终限重 lb（性能限重与结构限重取小）；rejected 时为 null */
  limitWeight: number | null
  /** 性能表是否真正约束（false=表内最大重量仍满足或无障碍，限重来自结构值） */
  performanceBounded: boolean
  /** 结构限重（起飞类=MTOW，着陆=MLW） */
  structuralLimit: number | null
  /** 当前重量相对限重的裕量 lb（正=有余量，负=超出） */
  margin: number | null
  /** 距离类：当前重量修正后的所需距离与可用距离；梯度类：当前可用梯度/所需梯度 */
  actualValue: number | null
  referenceValue: number | null
  unit: 'ft' | '%'
  /** 拒绝原因 */
  error: LookupError | null
  /** 输入来源链（表值、每一步修正） */
  sources: SourceStep[]
}

export interface PerfResult {
  ok: boolean
  perfVersion: string
  airportId: string
  runwayId: string
  end: RunwayEnd
  runway: Runway
  /** 沿起飞跑道方向分解的风分量：正=逆风，负=顺风 */
  headwindComponent: number
  phases: Record<PhaseId, PhaseResult>
  /** 起飞三阶段（滑跑/全发/单发）中最小的限重；任一被拒绝则为 null */
  takeoffLimit: number | null
  /** 起飞控制阶段（限重最小者） */
  takeoffControllingPhase: PhaseId | null
  /** 着陆阶段限重；被拒绝则为 null */
  landingLimit: number | null
  /** 无法计算的阶段（拒绝）列表 */
  rejected: PhaseId[]
  /** 致命错误（机场/机型不匹配），存在时所有阶段均拒绝 */
  fatalError: LookupError | null
  sources: SourceStep[]
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** 风分量（节，正=逆风）：风向指风的来向，航向 h 上逆风 = cos(windFrom − heading)·speed */
export function windOnRunway(windSpeed: number, windFrom: number, heading: number): number {
  const rad = ((windFrom - heading) * Math.PI) / 180
  return Math.cos(rad) * windSpeed
}

function rejected(phase: PhaseId, error: LookupError, sources: SourceStep[]): PhaseResult {
  return {
    phase,
    name: phaseNames[phase],
    status: 'rejected',
    limitWeight: null,
    performanceBounded: false,
    structuralLimit: null,
    margin: null,
    actualValue: null,
    referenceValue: null,
    unit: phase === 'groundRun' || phase === 'landing' ? 'ft' : '%',
    error,
    sources,
  }
}

/** 顺风超过审定时给出拒绝原因，否则 null */
function tailwindError(headwind: number, maxTail: number): LookupError | null {
  if (-headwind > maxTail + 1e-9) {
    return {
      code: 'OUT_OF_RANGE',
      axis: 'weight',
      message: `顺风 ${round1(-headwind)} kt 超过审定顺风边界 ${maxTail} kt，拒绝放行（不得外推）`,
    }
  }
  return null
}

export interface DistanceCorrectionsResult {
  /** 各步修正后的累计所需距离乘数（相对原始干、无风、平坡距离） */
  factor: number
  windFactor: number
  slopeAddCoefficient: number
  surfaceFactor: number
  steps: SourceStep[]
}

/**
 * 按规定顺序对「表列所需距离」施加修正（各步作用对象不同，故顺序不可交换）：
 *   ① 风：D1 = D0·windFactor（逆风 <1，顺风 >1；加性百分比，每节 0.9%）
 *   ② 坡度：D2 = D1 + D0·slopeCoef（坡度加性修正针对**原始**滑跑距离）
 *      起飞上坡 +5%/%（增长距离）；着陆上坡 −5%/%（上坡减速，缩短着陆滑跑）
 *   ③ 道面：D3 = D2·surfaceFactor（湿道面对前两步修正后的总距离乘 wetFactor）
 * 即 D3 = D0·(windFactor + slopeCoef)·surfaceFactor。
 */
export function applyDistanceCorrections(
  headwind: number,
  slopePercent: number,
  surface: SurfaceState,
  c: AircraftPerformance['corrections'],
  phase: PhaseId,
): DistanceCorrectionsResult {
  // ① 风
  const windFactor =
    1 - Math.max(headwind, 0) * c.windDistancePerKnot + Math.max(-headwind, 0) * c.windDistancePerKnot
  // ② 坡度（加性系数，施加于未经风修正的原始表列距离；着陆上坡有利取负号）
  const slopeSign = phase === 'landing' ? -1 : 1
  const slopeAddCoefficient = slopeSign * slopePercent * c.slopeDistancePerPercent
  // ③ 道面
  const wetFactor = phase === 'landing' ? c.wetLandingFactor : c.wetGroundRunFactor
  const surfaceFactor = surface === 'wet' ? wetFactor : 1

  const factor = (windFactor + slopeAddCoefficient) * surfaceFactor
  const steps: SourceStep[] = [
    {
      label: '① 风',
      detail: `${headwind >= 0 ? '逆风' : '顺风'} ${Math.abs(headwind)} kt → D1 = D0×${round1(windFactor)}`,
    },
    {
      label: '② 坡度',
      detail: `${slopePercent > 0 ? '上坡' : slopePercent < 0 ? '下坡' : '平坡'} ${Math.abs(slopePercent)}% → D2 = D1 + D0×${round1(slopeAddCoefficient)}`,
    },
    {
      label: '③ 道面',
      detail: `${surface === 'wet' ? '湿' : '干'} → D3 = D2×${round1(surfaceFactor)}`,
    },
  ]
  return { factor, windFactor, slopeAddCoefficient, surfaceFactor, steps }
}

export interface EvaluateOptions {
  /** 当前起飞重量（用于裕量计算），缺省时裕量为 null */
  takeoffWeight?: number
  /** 当前落地重量 */
  landingWeight?: number
}

/**
 * 执行完整跑道性能放行计算。
 * 任何阶段无法计算都明确标记 rejected 并给出原因；控制限重只在四阶段全部可算时给出。
 */
export function evaluateRunway(
  aircraft: Aircraft,
  input: PerfInput,
  options: EvaluateOptions = {},
  perf: AircraftPerformance = k12Performance,
): PerfResult {
  const sources: SourceStep[] = []
  const airport = getAirport(input.airportId)
  const runway = airport ? getRunway(airport, input.runwayId) : undefined

  if (!airport || !runway) {
    return makeFatal(
      input,
      { code: 'NO_TABLE_DATA', message: `找不到机场 ${input.airportId} 或跑道 ${input.runwayId}，无法放行` },
      perf,
    )
  }
  if (perf.aircraftId !== aircraft.id) {
    return makeFatal(
      input,
      { code: 'NO_TABLE_DATA', message: `性能表 ${perf.aircraftId} 与机型 ${aircraft.id} 不匹配` },
      perf,
    )
  }

  const end = runway.ends[input.endIndex]
  const heading = end.heading
  const headwind = Math.round(windOnRunway(input.windSpeed, input.windDirection, heading) * 10) / 10

  sources.push({
    label: '数据版本',
    detail: `${perf.version} · ${airport.name} · 跑道 ${runway.name} 方向 ${end.designator}（方位 ${heading}°）`,
  })
  sources.push({
    label: '大气条件',
    detail: `气温 ${input.temperature}°C · 气压高度 ${input.pressureAltitude} ft · 道面${input.surface === 'wet' ? '湿' : '干'}`,
  })
  sources.push({
    label: '风分解',
    detail: `风 ${input.windSpeed} kt @ ${input.windDirection}° → 沿起飞方向 ${headwind >= 0 ? '逆风' : '顺风'} ${Math.abs(headwind)} kt`,
  })

  const phases = {} as Record<PhaseId, PhaseResult>
  const rejectedList: PhaseId[] = []

  // 起飞方向顺风边界（影响起飞三阶段）
  const takeoffTailwind = tailwindError(headwind, perf.corrections.maxTailwindKnot)

  // 沿运行方向的坡度：ends[1] 方向与定义方向相反，坡度取反
  const slopePercent = input.endIndex === 0 ? runway.slope : -runway.slope

  const marginTow = (limit: number) =>
    options.takeoffWeight === undefined ? null : limit - options.takeoffWeight
  const marginLw = (limit: number) =>
    options.landingWeight === undefined ? null : limit - options.landingWeight

  // ---- 起飞滑跑（距离类） ----
  phases.groundRun = distancePhase({
    phase: 'groundRun',
    perf,
    input,
    headwind,
    slopePercent,
    available: end.tora,
    currentWeight: options.takeoffWeight,
    structuralLimit: aircraft.mtow,
    tailwind: takeoffTailwind,
    margin: marginTow,
  })
  if (phases.groundRun.status === 'rejected') rejectedList.push('groundRun')

  // ---- 着陆：与起飞同方向（逆风同样缩短着陆滑跑；上坡帮助减速，符号在修正层翻转） ----
  phases.landing = distancePhase({
    phase: 'landing',
    perf,
    input,
    headwind,
    slopePercent,
    available: end.tora,
    currentWeight: options.landingWeight,
    structuralLimit: aircraft.mlw,
    tailwind: takeoffTailwind,
    margin: marginLw,
    sourcePrefix: `着陆沿同方向 ${end.designator}`,
  })
  if (phases.landing.status === 'rejected') rejectedList.push('landing')

  // ---- 越障梯度类 ----
  const obstacleGradient =
    end.obstacleHeight > 0 && end.obstacleDistance > 0
      ? (end.obstacleHeight / end.obstacleDistance) * 100
      : 0

  phases.climbAllEngines = gradientPhase({
    phase: 'climbAllEngines',
    perf,
    input,
    obstacleHeight: end.obstacleHeight,
    obstacleDistance: end.obstacleDistance,
    obstacleGradient,
    currentWeight: options.takeoffWeight,
    structuralLimit: aircraft.mtow,
    tailwind: takeoffTailwind,
    margin: marginTow,
    wetWeightFactor: 1,
  })
  if (phases.climbAllEngines.status === 'rejected') rejectedList.push('climbAllEngines')

  phases.climbOneEngine = gradientPhase({
    phase: 'climbOneEngine',
    perf,
    input,
    obstacleHeight: end.obstacleHeight,
    obstacleDistance: end.obstacleDistance,
    obstacleGradient,
    currentWeight: options.takeoffWeight,
    structuralLimit: aircraft.mtow,
    tailwind: takeoffTailwind,
    margin: marginTow,
    wetWeightFactor: input.surface === 'wet' ? perf.corrections.wetOneEngineWeightFactor : 1,
  })
  if (phases.climbOneEngine.status === 'rejected') rejectedList.push('climbOneEngine')

  // ---- 起飞限重与着陆限重（分开取最小，任一阶段拒绝则对应限重为 null） ----
  let takeoffLimit: number | null = null
  let takeoffControllingPhase: PhaseId | null = null
  if (!TAKEOFF_PHASE_IDS.some((p) => rejectedList.includes(p))) {
    for (const p of TAKEOFF_PHASE_IDS) {
      const lw = phases[p].limitWeight
      if (lw === null) continue
      if (takeoffLimit === null || lw < takeoffLimit) {
        takeoffLimit = lw
        takeoffControllingPhase = p
      }
    }
  }
  const landingLimit = phases.landing.status === 'rejected' ? null : phases.landing.limitWeight

  return {
    ok: rejectedList.length === 0,
    perfVersion: perf.version,
    airportId: input.airportId,
    runwayId: input.runwayId,
    end,
    runway,
    headwindComponent: headwind,
    phases,
    takeoffLimit,
    takeoffControllingPhase,
    landingLimit,
    rejected: rejectedList,
    fatalError: null,
    sources,
  }
}

/** 组装致命错误结果（机场/机型不匹配等） */
function makeFatal(input: PerfInput, error: LookupError, perf: AircraftPerformance): PerfResult {
  const airport = getAirport(input.airportId)
  const runway = airport ? getRunway(airport, input.runwayId) : undefined
  const end: RunwayEnd =
    runway?.ends[input.endIndex] ?? {
      designator: '—',
      heading: 0,
      tora: 0,
      obstacleHeight: 0,
      obstacleDistance: 0,
    }
  const fallbackRunway: Runway =
    runway ?? { id: input.runwayId, name: '—', ends: [end, end], slope: 0, surface: 'asphalt' }
  const mk = (phase: PhaseId): PhaseResult => ({
    phase,
    name: phaseNames[phase],
    status: 'rejected',
    limitWeight: null,
    performanceBounded: false,
    structuralLimit: null,
    margin: null,
    actualValue: null,
    referenceValue: null,
    unit: phase === 'groundRun' || phase === 'landing' ? 'ft' : '%',
    error,
    sources: [],
  })
  return {
    ok: false,
    perfVersion: perf.version,
    airportId: input.airportId,
    runwayId: input.runwayId,
    end,
    runway: fallbackRunway,
    headwindComponent: 0,
    phases: {
      groundRun: mk('groundRun'),
      climbAllEngines: mk('climbAllEngines'),
      climbOneEngine: mk('climbOneEngine'),
      landing: mk('landing'),
    },
    takeoffLimit: null,
    takeoffControllingPhase: null,
    landingLimit: null,
    rejected: [...phaseOrder],
    fatalError: error,
    sources: [],
  }
}

interface DistancePhaseArgs {
  phase: PhaseId
  perf: AircraftPerformance
  input: PerfInput
  headwind: number
  slopePercent: number
  available: number
  currentWeight?: number
  structuralLimit: number
  tailwind: LookupError | null
  margin: (limit: number) => number | null
  sourcePrefix?: string
}

/** 距离类阶段（滑跑/着陆）：按 风→坡度→道面 还原表列当量距离，再反解限重 */
function distancePhase(args: DistancePhaseArgs): PhaseResult {
  const { phase, perf, input, headwind, slopePercent, available, currentWeight, structuralLimit, tailwind, margin } =
    args
  const sources: SourceStep[] = []
  if (args.sourcePrefix) sources.push({ label: '运行方向', detail: args.sourcePrefix })
  sources.push({ label: '公布可用距离', detail: `${available} ft` })

  if (tailwind) return rejected(phase, tailwind, sources)

  const corr = applyDistanceCorrections(headwind, slopePercent, input.surface, perf.corrections, phase)
  sources.push({
    label: '修正顺序：风 → 坡度 → 道面',
    detail: corr.steps.map((s) => `${s.label}（${s.detail}）`).join('；'),
  })

  // D0(w)·factor ≤ available ⇒ 表列当量可用距离：
  const equivalent = available / corr.factor
  sources.push({
    label: '表列当量可用距离',
    detail: `${Math.round(equivalent)} ft（干、无风、平坡基准；综合乘数 ×${round1(corr.factor)}）`,
  })

  const table = perf.tables[phase as PerformanceKind]
  const inv = invertWeightAtLimit(table, input.pressureAltitude, input.temperature, equivalent, 'distance')
  if (!inv.ok) return rejected(phase, inv.error, sources)

  // 性能限重与结构限重取小；表内不约束时限重即结构值
  const perfWeight = Math.floor(inv.value.weight)
  const limitWeight = Math.min(perfWeight, structuralLimit)
  const performanceBounded = inv.value.bounded && perfWeight <= structuralLimit
  sources.push({
    label: '表值反解',
    detail: `${phaseNames[phase]}表（${perf.version}）双线性插值反解 → 性能限重 ${perfWeight} lb` +
      (inv.value.bounded ? '' : '（表列最大重量仍满足，不受表约束）') +
      `；与结构限重 ${structuralLimit} lb 取小 → ${limitWeight} lb`,
  })

  // 当前重量修正后的所需距离（仅用于距离条；当前重量超出表范围时不夹值、留空）
  let actualValue: number | null = null
  if (currentWeight !== undefined) {
    const base = interpolate3(table, input.pressureAltitude, input.temperature, currentWeight)
    if (base.ok) actualValue = round1(base.value * corr.factor)
  }

  return {
    phase,
    name: phaseNames[phase],
    status: performanceBounded ? 'limited' : 'not-limiting',
    limitWeight,
    performanceBounded,
    structuralLimit,
    margin: margin(limitWeight),
    actualValue,
    referenceValue: available,
    unit: 'ft',
    error: null,
    sources,
  }
}

interface GradientPhaseArgs {
  phase: PhaseId
  perf: AircraftPerformance
  input: PerfInput
  obstacleHeight: number
  obstacleDistance: number
  obstacleGradient: number
  currentWeight?: number
  structuralLimit: number
  tailwind: LookupError | null
  margin: (limit: number) => number | null
  /** 湿道面限重折减系数（仅单发） */
  wetWeightFactor: number
}

/** 越障梯度类阶段：所需越障总梯度 = 障碍物高 / 水平距离；反解满足该梯度的最大重量 */
function gradientPhase(args: GradientPhaseArgs): PhaseResult {
  const {
    phase,
    perf,
    input,
    obstacleHeight,
    obstacleDistance,
    obstacleGradient,
    currentWeight,
    structuralLimit,
    tailwind,
    margin,
    wetWeightFactor,
  } = args
  const sources: SourceStep[] = []

  if (obstacleHeight <= 0) {
    sources.push({ label: '障碍物', detail: '该方向无障碍物，本阶段不构成限制，限重取结构 MTOW' })
    return {
      phase,
      name: phaseNames[phase],
      status: 'not-limiting',
      limitWeight: structuralLimit,
      performanceBounded: false,
      structuralLimit,
      margin: margin(structuralLimit),
      actualValue: null,
      referenceValue: null,
      unit: '%',
      error: null,
      sources,
    }
  }

  sources.push({
    label: '障碍物剖面',
    detail: `高 ${obstacleHeight} ft @ 水平距离 ${obstacleDistance} ft → 所需越障总梯度 ≥ ${obstacleGradient.toFixed(2)}%`,
  })
  sources.push({
    label: '修正顺序：风 → 坡度 → 道面',
    detail:
      phase === 'climbOneEngine' && wetWeightFactor < 1
        ? `风与坡度不改审定梯度；顺风边界已先行检查；③ 湿道面对单发限重 ×${wetWeightFactor} 折减`
        : '风与坡度不改审定梯度；顺风边界已先行检查；干道面无折减',
  })

  if (tailwind) return rejected(phase, tailwind, sources)

  const table = perf.tables[phase as PerformanceKind]
  const inv = invertWeightAtLimit(
    table,
    input.pressureAltitude,
    input.temperature,
    obstacleGradient,
    'gradient',
  )
  if (!inv.ok) return rejected(phase, inv.error, sources)

  const dryWeight = Math.floor(inv.value.weight)
  const wetWeight = Math.floor(dryWeight * wetWeightFactor)
  const limitWeight = Math.min(wetWeight, structuralLimit)
  // 干表反解到界或湿道面折减使重量低于结构限重，都算性能真正约束
  const performanceBounded =
    wetWeight < structuralLimit || (wetWeightFactor === 1 && inv.value.bounded)
  if (wetWeightFactor < 1) {
    sources.push({
      label: '湿道面折减',
      detail: `干跑道反解 ${dryWeight} lb × ${wetWeightFactor} → ${wetWeight} lb`,
    })
  }
  sources.push({
    label: '表值反解',
    detail: `${phaseNames[phase]}表（${perf.version}）双线性插值反解 → 限重 ${wetWeight} lb；与结构限重 ${structuralLimit} lb 取小 → ${limitWeight} lb`,
  })

  // 当前重量下的可用梯度（用于梯度条；超出表范围留空，不夹值）
  let actualValue: number | null = null
  if (currentWeight !== undefined) {
    const g = interpolate3(table, input.pressureAltitude, input.temperature, currentWeight)
    if (g.ok) actualValue = round1(g.value)
  }

  return {
    phase,
    name: phaseNames[phase],
    status: performanceBounded ? 'limited' : 'not-limiting',
    limitWeight,
    performanceBounded,
    structuralLimit,
    margin: margin(limitWeight),
    actualValue,
    referenceValue: round1(obstacleGradient),
    unit: '%',
    error: null,
    sources,
  }
}

/** 默认跑道输入：短湿跑道示例（云川 09/27，09 方向，28°C，10 kt 正西逆风） */
export function defaultPerfInput(): PerfInput {
  return {
    airportId: 'YZC',
    runwayId: 'rwy09',
    endIndex: 0,
    temperature: 28,
    pressureAltitude: 2040,
    windSpeed: 10,
    windDirection: 90,
    surface: 'wet',
  }
}
