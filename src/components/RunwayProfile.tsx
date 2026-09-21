import type { PerformanceReport, StageResult } from '../lib/performance'
import { TAKEOFF_SCREEN_FT } from '../lib/perfTables'

const W = 700
const H = 230
const X0 = 70
const X1 = 640

/**
 * 跑道剖面图：按真实距离比例画 TORA（起飞可用）与 LDA（着陆可用），
 * 标注起飞端、坡度方向、障碍物（高/距/净梯度），以及当前重量下所需距离的越界位置。
 */
export function RunwayProfile({ report }: { report: PerformanceReport }) {
  const r = report.resolved
  if (!r) {
    return (
      <section className="panel profile-panel">
        <h2>跑道剖面</h2>
        <p className="hint">未选择有效跑道。</p>
      </section>
    )
  }
  const { end, obstacle } = r

  const tod = report.stages.tod
  const ld = report.stages.landing
  const todReq = tod.status === 'ok' ? tod.requiredDistanceFt : null
  const ldReq = ld.status === 'ok' ? ld.requiredDistanceFt : null
  const domain = Math.max(
    end.toraFt,
    end.ldaFt,
    obstacle.value.distanceFt,
    todReq ?? 0,
    ldReq ?? 0,
  ) * 1.12

  const x = (ft: number) => X0 + (ft / domain) * (X1 - X0)

  const slopeUp = end.slopePct >= 0
  const ob = obstacle.value
  const obSignificant = ob.heightFt > TAKEOFF_SCREEN_FT

  return (
    <section className="panel profile-panel">
      <h2>
        跑道剖面 · {r.airport.name} {r.runway.name} {end.id} 号方向
      </h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="跑道剖面图">
        {/* TORA 条 */}
        <text x={X0} y={48} className="tick" textAnchor="middle">
          起飞端 {end.id}
        </text>
        <rect x={X0} y={58} width={x(end.toraFt) - X0} height={16} rx={3} className="rwy-bar tora" />
        <text x={x(end.toraFt) + 6} y={71} className="tick">
          TORA {end.toraFt.toLocaleString()} ft
        </text>
        {todReq !== null && (
          <g>
            <line
              x1={x(todReq)}
              y1={52}
              x2={x(todReq)}
              y2={100}
              className={todReq > end.toraFt ? 'req-line bad' : 'req-line ok'}
            />
            <text x={x(todReq)} y={48} className={`tick ${todReq > end.toraFt ? 'bad-text' : ''}`} textAnchor="middle">
              需 {todReq.toLocaleString()} ft
            </text>
          </g>
        )}

        {/* 跑道主体 */}
        <rect x={X0} y={92} width={x(Math.max(end.toraFt, end.ldaFt)) - X0} height={30} className="rwy-body" />
        {Array.from({ length: 8 }).map((_, i) => {
          const fx = X0 + ((i + 0.5) / 8) * (x(Math.max(end.toraFt, end.ldaFt)) - X0)
          return <line key={i} x1={fx} y1={102} x2={fx + 14} y2={102} className="rwy-centerline" />
        })}
        {/* 坡度方向 */}
        <text x={X0 + 6} y={116} className="slope-mark">
          {slopeUp ? '▲ 上坡' : '▼ 下坡'} {Math.abs(end.slopePct)}%
          {obstacle.source === 'user' ? ' · 坡度为人工输入' : ''}
        </text>

        {/* LDA 条 */}
        <rect x={X0} y={136} width={x(end.ldaFt) - X0} height={16} rx={3} className="rwy-bar lda" />
        <text x={x(end.ldaFt) + 6} y={149} className="tick">
          LDA {end.ldaFt.toLocaleString()} ft
        </text>
        {ldReq !== null && (
          <g>
            <line
              x1={x(ldReq)}
              y1={130}
              x2={x(ldReq)}
              y2={164}
              className={ldReq > end.ldaFt ? 'req-line bad' : 'req-line ok'}
            />
            <text x={x(ldReq)} y={178} className={`tick ${ldReq > end.ldaFt ? 'bad-text' : ''}`} textAnchor="middle">
              着陆需 {ldReq.toLocaleString()} ft
            </text>
          </g>
        )}

        {/* 障碍物 */}
        <g>
          <line
            x1={x(ob.distanceFt)}
            y1={86}
            x2={x(ob.distanceFt)}
            y2={136}
            className={obSignificant ? 'ob-line' : 'ob-line none'}
            strokeDasharray="3 3"
          />
          <polygon
            points={`${x(ob.distanceFt) - 7},88 ${x(ob.distanceFt) + 7},88 ${x(ob.distanceFt)},72`}
            className={obSignificant ? 'ob-marker' : 'ob-marker none'}
          />
          <text x={x(ob.distanceFt)} y={64} className="tick" textAnchor="middle">
            障碍物 {ob.heightFt} ft
          </text>
          <text x={x(ob.distanceFt)} y={196} className="tick" textAnchor="middle">
            距起飞端 {ob.distanceFt.toLocaleString()} ft
            {obSignificant ? ` · 净梯度 ${report.resolved!.obstacleGradientPct.toFixed(2)}%` : ' · 低于屏隐高'}
          </text>
          {obstacle.source === 'user' && (
            <text x={x(ob.distanceFt)} y={210} className="src-tag" textAnchor="middle">
              障碍物数据为人工输入
            </text>
          )}
        </g>

        {/* 风向简标 */}
        <g transform={`translate(${X1 - 30}, 100)`}>
          <circle r={16} className="wind-compass" />
          <text y={-20} className="tick" textAnchor="middle">
            {r.windSpeedKt === 0 ? '静风' : `${r.windDirDeg}° ${r.windSpeedKt}kt`}
          </text>
          {r.windSpeedKt > 0 && (
            <line
              x1={0}
              y1={-9}
              x2={0}
              y2={9}
              className="wind-arrow"
              transform={`rotate(${r.end.heading - r.windDirDeg})`}
            />
          )}
        </g>
      </svg>
      <DistanceLegend stage={tod} label="起飞滑跑所需 / TORA" />
      <DistanceLegend stage={ld} label="着陆滑跑所需 / LDA" />
    </section>
  )
}

function DistanceLegend({ stage, label }: { stage: StageResult; label: string }) {
  if (stage.status !== 'ok' || stage.requiredDistanceFt === null) return null
  const ratio = stage.requiredDistanceFt / (stage.availableDistanceFt ?? 1)
  const pct = Math.min(ratio * 100, 100)
  const overflow = ratio > 1
  return (
    <div className={`distance-bar ${overflow ? 'over' : ''}`}>
      <span className="distance-label">
        {label}：{stage.requiredDistanceFt.toLocaleString()} / {stage.availableDistanceFt!.toLocaleString()} ft
        {overflow && <em className="bad-text">（超出 {Math.round((ratio - 1) * 100)}%）</em>}
      </span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  )
}
