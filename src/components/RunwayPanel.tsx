import type { Computed } from '../lib/limits'
import { airports } from '../lib/performanceData'
import {
  phaseNames,
  phaseOrder,
  type PerfInput,
  type PerfResult,
  type PhaseResult,
  type PhaseId,
} from '../lib/performance'

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

interface RunwayPanelProps {
  perf: PerfResult
  input: PerfInput
  computed: Computed
  onChange: (patch: Partial<PerfInput>) => void
}

/** 条填充 = 当前重量对该阶段限重的占用（>1 即超限）；距离/梯度物理值仅作副文 */
function usageOf(p: PhaseResult, currentWeight: number): number | null {
  if (p.status === 'rejected' || p.limitWeight == null) return null
  return currentWeight / p.limitWeight
}

function barState(p: PhaseResult): 'ok' | 'bad' | 'none' {
  if (p.status === 'rejected') return 'bad'
  if (p.margin == null) return 'none'
  return p.margin >= 0 ? 'ok' : 'bad'
}

/** 跑道剖面侧视示意图（坡度垂直方向做了视觉放大，不代表真实比例） */
function RunwayProfile({ perf, input }: { perf: PerfResult; input: PerfInput }) {
  const W = 660
  const H = 172
  const x0 = 46
  const x1 = W - 40
  const end = perf.end
  const scale = (x1 - x0) / end.tora
  const slopePct = input.endIndex === 0 ? perf.runway.slope : -perf.runway.slope
  const dy = Math.max(-30, Math.min(30, -slopePct * 14)) // 上坡 → 右端抬高（y 减小）
  const yBase = 118
  const xOb = end.obstacleDistance > 0 ? x0 + end.obstacleDistance * scale : 0
  const obH = end.obstacleHeight > 0 ? Math.max(14, (end.obstacleHeight / 60) * 86) : 0
  const groundY = yBase + 24

  const hw = perf.headwindComponent
  const windLabel = hw >= 0 ? `逆风 ${Math.abs(hw)} kt` : `顺风 ${Math.abs(hw)} kt`
  // 起飞方向 →（向右）；逆风箭头指向左（迎向飞机）
  const windPath = hw >= 0 ? 'M84 40 h34 M110 34 l9 6 -9 6' : 'M118 40 h-34 M92 34 l-9 6 9 6'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="runway-svg" role="img" aria-label="跑道剖面示意图">
      {/* 风 */}
      <g className="rw-wind">
        <path d={windPath} fill="none" strokeWidth={2} markerEnd="" />
        <text x={60} y={28} className="rw-label">
          {windLabel}
        </text>
      </g>

      {/* 地面线 */}
      <line x1={x0 - 14} y1={groundY} x2={x1 + 14} y2={groundY} className="rw-ground" />

      {/* 跑道（带坡度的厚线） */}
      <line x1={x0} y1={yBase} x2={x1} y2={yBase + dy} className="rw-strip" />
      {/* 跑道端标识/入口 */}
      <line x1={x0} y1={yBase - 7} x2={x0} y2={yBase + 7} className="rw-threshold" />
      <line x1={x1} y1={yBase + dy - 7} x2={x1} y2={yBase + dy + 7} className="rw-threshold" />
      <text x={x0} y={yBase + 22} className="rw-label" textAnchor="middle">
        {end.designator}
      </text>
      <text x={x1} y={yBase + dy + 22} className="rw-label" textAnchor="middle">
        {perf.runway.ends[input.endIndex === 0 ? 1 : 0].designator}
      </text>

      {/* 障碍物 + 越障剖面线 */}
      {end.obstacleHeight > 0 && (
        <g>
          <polygon
            points={`${xOb - 9},${yBase + dy * ((xOb - x0) / (x1 - x0))} ${xOb + 9},${yBase + dy * ((xOb - x0) / (x1 - x0))} ${xOb},${yBase + dy * ((xOb - x0) / (x1 - x0)) - obH}`}
            className="rw-obstacle"
          />
          <text x={xOb} y={yBase + dy * ((xOb - x0) / (x1 - x0)) - obH - 6} className="rw-ob-label" textAnchor="middle">
            障碍 {end.obstacleHeight} ft
          </text>
          <text x={xOb} y={yBase + dy * ((xOb - x0) / (x1 - x0)) - obH - 19} className="rw-ob-sub" textAnchor="middle">
            @ {end.obstacleDistance} ft · 需 {(end.obstacleHeight / end.obstacleDistance * 100).toFixed(2)}%
          </text>
        </g>
      )}

      {/* TORA 标注括号 */}
      <g className="rw-dim">
        <line x1={x0} y1={groundY + 12} x2={x1} y2={groundY + 12} />
        <line x1={x0} y1={groundY + 8} x2={x0} y2={groundY + 16} />
        <line x1={x1} y1={groundY + 8} x2={x1} y2={groundY + 16} />
        <text x={(x0 + x1) / 2} y={groundY + 27} className="rw-label" textAnchor="middle">
          TORA {fmt(end.tora)} ft
        </text>
      </g>

      {/* 坡度 */}
      <text x={x1} y={Math.min(yBase, yBase + dy) - 12} className="rw-slope" textAnchor="end">
        纵向坡度 {slopePct > 0 ? '上坡' : slopePct < 0 ? '下坡' : '平坡'} {Math.abs(slopePct).toFixed(1)}%（示意，垂直已放大）
      </text>
    </svg>
  )
}

const numberField = (
  label: string,
  value: number,
  unit: string,
  onChange: (v: number) => void,
  aria: string,
  step = 1,
) => (
  <label className="perf-field">
    <span>{label}</span>
    <span className="perf-input-wrap">
      <input
        type="number"
        value={value}
        step={step}
        aria-label={aria}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <em>{unit}</em>
    </span>
  </label>
)

/** 跑道性能放行面板：条件输入、剖面、四阶段距离条、限重/裕量/来源 */
export function RunwayPanel({ perf, input, computed, onChange }: RunwayPanelProps) {
  const airport = airports.find((a) => a.id === input.airportId) ?? airports[0]
  const runway = airport.runways.find((r) => r.id === input.runwayId) ?? airport.runways[0]

  const go = perf.ok && (perf.takeoffLimit ?? Infinity) >= computed.takeoff.weight
    && (perf.landingLimit ?? Infinity) >= computed.landing.weight

  return (
    <section className="panel runway-panel">
      <div className="runway-head">
        <h2>跑道性能放行</h2>
        <span className="perf-version">{perf.perfVersion}</span>
      </div>

      <div className="perf-inputs">
        <label className="perf-field">
          <span>机场</span>
          <select
            value={input.airportId}
            onChange={(e) => onChange({ airportId: e.target.value, runwayId: airports.find((a) => a.id === e.target.value)!.runways[0].id, endIndex: 0 })}
          >
            {airports.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="perf-field">
          <span>跑道</span>
          <select value={input.runwayId} onChange={(e) => onChange({ runwayId: e.target.value, endIndex: 0 })}>
            {airport.runways.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}（{r.surface === 'concrete' ? '水泥' : r.surface === 'asphalt' ? '沥青' : '碎石'}）
              </option>
            ))}
          </select>
        </label>
        <div className="perf-field">
          <span>使用方向</span>
          <div className="seg">
            {runway.ends.map((e, i) => (
              <button
                type="button"
                key={e.designator}
                className={input.endIndex === i ? 'on' : ''}
                onClick={() => onChange({ endIndex: i as 0 | 1 })}
              >
                {e.designator}
              </button>
            ))}
          </div>
        </div>
        <div className="perf-field">
          <span>道面</span>
          <div className="seg">
            <button type="button" className={input.surface === 'dry' ? 'on' : ''} onClick={() => onChange({ surface: 'dry' })}>
              干
            </button>
            <button type="button" className={input.surface === 'wet' ? 'on' : ''} onClick={() => onChange({ surface: 'wet' })}>
              湿
            </button>
          </div>
        </div>
        {numberField('气温', input.temperature, '°C', (v) => onChange({ temperature: v }), '气温')}
        {numberField('气压高度', input.pressureAltitude, 'ft', (v) => onChange({ pressureAltitude: v }), '气压高度', 10)}
        {numberField('风速', input.windSpeed, 'kt', (v) => onChange({ windSpeed: Math.max(0, v) }), '风速')}
        {numberField('风向', input.windDirection, '°', (v) => onChange({ windDirection: v }), '风向（来向）', 5)}
      </div>

      <RunwayProfile perf={perf} input={input} />

      {perf.fatalError && <div className="perf-fatal">⛔ {perf.fatalError.message}</div>}

      {/* 四阶段距离条 + 限重 */}
      <div className="phase-bars">
        {phaseOrder.map((id) => {
          const p = perf.phases[id]
          const isLanding = id === 'landing'
          const currentW = isLanding ? computed.landing.weight : computed.takeoff.weight
          const u = usageOf(p, currentW)
          const state = barState(p)
          return (
            <div className={`phase-row ${p.status}`} key={id}>
              <div className="phase-meta">
                <span className="phase-name">
                  {phaseNames[id]}
                  {perf.takeoffControllingPhase === id && !isLanding && <em className="ctrl-tag">控制</em>}
                </span>
                {p.status === 'rejected' ? (
                  <span className="phase-reject">⛔ {p.error?.message}</span>
                ) : (
                  <span className="phase-nums">
                    <span className={p.margin != null && p.margin < 0 ? 'bad' : 'ok'}>
                      限重 {p.limitWeight == null ? '—' : fmt(p.limitWeight)} lb
                    </span>
                    <span className="phase-current">当前 {fmt(currentW)} lb</span>
                    <span className={p.margin != null && p.margin < 0 ? 'bad' : 'muted'}>
                      裕量 {p.margin == null ? '—' : p.margin > 0 ? `+${fmt(p.margin)}` : fmt(p.margin)} lb
                    </span>
                  </span>
                )}
              </div>
              {p.status !== 'rejected' && u !== null && (
                <div className="bar-track" title={`当前重量为限重的 ${(u * 100).toFixed(0)}%`}>
                  <div className={`bar-fill ${state}`} style={{ width: `${Math.min(u * 100, 100)}%` }} />
                  <span className="bar-cap">
                    {id === 'groundRun' || id === 'landing'
                      ? `所需/可用距离 ${p.actualValue == null ? '—' : fmt(p.actualValue)} / ${fmt(p.referenceValue!)} ft`
                      : p.actualValue == null
                        ? '无障碍，限重取结构 MTOW'
                        : `可用梯度 ${p.actualValue}% / 需 ${p.referenceValue}%（湿道面限重另折减）`}
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 总结 */}
      <div className={`perf-summary ${go ? 'go' : 'nogo'}`}>
        {perf.ok ? (
          <>
            <span className="perf-verdict">{go ? '✅ 性能放行通过' : '⛔ 重量超过跑道限重，不可放行'}</span>
            <span>
              起飞限重 <strong>{perf.takeoffLimit == null ? '—' : fmt(perf.takeoffLimit)}</strong> lb
              {perf.takeoffControllingPhase && <em>（{phaseNames[perf.takeoffControllingPhase as PhaseId]}控制）</em>}
              {' · '}当前 {fmt(computed.takeoff.weight)} lb
            </span>
            <span>
              着陆限重 <strong>{perf.landingLimit == null ? '—' : fmt(perf.landingLimit)}</strong> lb · 当前{' '}
              {fmt(computed.landing.weight)} lb
            </span>
          </>
        ) : (
          <span className="perf-verdict">⛔ 性能条件超出审定范围，本跑道拒绝放行（不外推、不夹值）</span>
        )}
      </div>

      <details className="perf-sources">
        <summary>输入来源与修正链（{perf.sources.length} 条全局 + 各阶段表值反解）</summary>
        <ul>
          {perf.sources.map((s, i) => (
            <li key={i}>
              <span>{s.label}</span>
              <span className="detail">{s.detail}</span>
            </li>
          ))}
        </ul>
        {phaseOrder.map((id) => (
          <div key={id} className="phase-sources">
            <strong>{phaseNames[id]}</strong>
            {perf.phases[id].status === 'rejected' ? (
              <span className="detail bad">{perf.phases[id].error?.message}</span>
            ) : (
              <ul>
                {perf.phases[id].sources.map((s, i) => (
                  <li key={i}>
                    <span>{s.label}</span>
                    <span className="detail">{s.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </details>
    </section>
  )
}
