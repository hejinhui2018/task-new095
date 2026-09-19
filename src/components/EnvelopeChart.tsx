import type { Aircraft } from '../lib/types'
import type { Computed } from '../lib/limits'
import { envelopeViolation } from '../lib/envelope'
import { cgOf } from '../lib/weightBalance'

const W = 700
const H = 460
const MARGIN = { top: 18, right: 20, bottom: 40, left: 64 }

function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Math.round(v * 1000) / 1000)
  }
  return out
}

/**
 * 重量—重心包线图：包线多边形（随重量变化的前/后限）、
 * 重量限制线、从起飞到落地的耗油轨迹（越界段标红）与首次越界点。
 */
export function EnvelopeChart({ aircraft, computed }: { aircraft: Aircraft; computed: Computed }) {
  const env = aircraft.envelope
  const traj = computed.trajectory
  const zfwCg = cgOf(computed.zfw)

  const cgValues = [...traj.map((p) => p.cg), zfwCg]
  const wValues = [...traj.map((p) => p.weight), computed.zfw.weight, aircraft.mtow, aircraft.mlw]
  const xMin = Math.floor(Math.min(...env.map((p) => p.forwardArm), ...cgValues) - 2)
  const xMax = Math.ceil(Math.max(...env.map((p) => p.aftArm), ...cgValues) + 2)
  const yMin = Math.floor((Math.min(...wValues, ...env.map((p) => p.weight)) - 150) / 100) * 100
  const yMax = Math.ceil((Math.max(...wValues, ...env.map((p) => p.weight)) + 150) / 100) * 100

  const x = (arm: number) =>
    MARGIN.left + ((arm - xMin) / (xMax - xMin)) * (W - MARGIN.left - MARGIN.right)
  const y = (w: number) =>
    H - MARGIN.bottom - ((w - yMin) / (yMax - yMin)) * (H - MARGIN.top - MARGIN.bottom)

  const fwdPts = env.map((p) => `${x(p.forwardArm)},${y(p.weight)}`).join(' ')
  const aftPts = env.map((p) => `${x(p.aftArm)},${y(p.weight)}`).join(' ')
  const polygonPts = `${fwdPts} ${env
    .slice()
    .reverse()
    .map((p) => `${x(p.aftArm)},${y(p.weight)}`)
    .join(' ')}`

  // 轨迹分段：以段中点判定是否越界，越界段标红
  const segments = []
  for (let i = 1; i < traj.length; i++) {
    const a = traj[i - 1]
    const b = traj[i]
    const ok = !envelopeViolation(env, (a.weight + b.weight) / 2, (a.cg + b.cg) / 2)
    segments.push(
      <line
        key={i}
        x1={x(a.cg)}
        y1={y(a.weight)}
        x2={x(b.cg)}
        y2={y(b.weight)}
        className={`traj-seg ${ok ? 'ok' : 'bad'}`}
      />,
    )
  }

  // 油箱切换点（耗油阶段变化处）
  const switchPoints = traj.filter(
    (p, i) => i > 0 && i < traj.length - 1 && p.phase !== traj[i + 1].phase,
  )

  const takeoff = traj[0]
  const landing = traj[traj.length - 1]
  const v = computed.firstViolation

  return (
    <section className="panel chart-panel">
      <h2>重量 — 重心包线图</h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="重量重心包线图">
        {ticks(xMin, xMax, 5).map((t) => (
          <g key={`x${t}`}>
            <line x1={x(t)} y1={y(yMin)} x2={x(t)} y2={y(yMax)} className="grid" />
            <text x={x(t)} y={H - MARGIN.bottom + 16} className="tick" textAnchor="middle">
              {t}
            </text>
          </g>
        ))}
        {ticks(yMin, yMax, 500).map((t) => (
          <g key={`y${t}`}>
            <line x1={x(xMin)} y1={y(t)} x2={x(xMax)} y2={y(t)} className="grid" />
            <text x={MARGIN.left - 8} y={y(t) + 3} className="tick" textAnchor="end">
              {t.toLocaleString('en-US')}
            </text>
          </g>
        ))}

        <line x1={x(xMin)} y1={y(aircraft.mtow)} x2={x(xMax)} y2={y(aircraft.mtow)} className="limit-line mtow" />
        <text x={x(xMax) - 4} y={y(aircraft.mtow) - 5} className="limit-label mtow" textAnchor="end">
          MTOW {aircraft.mtow.toLocaleString('en-US')}
        </text>
        <line x1={x(xMin)} y1={y(aircraft.mlw)} x2={x(xMax)} y2={y(aircraft.mlw)} className="limit-line mlw" />
        <text x={x(xMax) - 4} y={y(aircraft.mlw) - 5} className="limit-label mlw" textAnchor="end">
          MLW {aircraft.mlw.toLocaleString('en-US')}
        </text>

        <polygon points={polygonPts} className="envelope-fill" />
        <polyline points={fwdPts} className="envelope-line fwd" />
        <polyline points={aftPts} className="envelope-line aft" />

        {segments}

        <circle cx={x(zfwCg)} cy={y(computed.zfw.weight)} r={4.5} className="pt zfw" />
        {switchPoints.map((p, i) => (
          <circle key={i} cx={x(p.cg)} cy={y(p.weight)} r={3.5} className="pt switch" />
        ))}
        <circle cx={x(takeoff.cg)} cy={y(takeoff.weight)} r={5.5} className="pt takeoff" />
        <rect
          x={x(landing.cg) - 5}
          y={y(landing.weight) - 5}
          width={10}
          height={10}
          className="pt landing"
        />

        {v && (
          <g>
            <circle cx={x(v.point.cg)} cy={y(v.point.weight)} r={9} className="violation-ring" />
            <text x={x(v.point.cg)} y={y(v.point.weight) - 14} className="violation-label" textAnchor="middle">
              首次越界
            </text>
          </g>
        )}

        <text
          x={MARGIN.left + (W - MARGIN.left - MARGIN.right) / 2}
          y={H - 6}
          className="axis-title"
          textAnchor="middle"
        >
          重心 CG（in，基准面之后）
        </text>
        <text
          x={14}
          y={MARGIN.top + (H - MARGIN.top - MARGIN.bottom) / 2}
          className="axis-title"
          textAnchor="middle"
          transform={`rotate(-90 14 ${MARGIN.top + (H - MARGIN.top - MARGIN.bottom) / 2})`}
        >
          重量（lb）
        </text>
      </svg>
      <div className="legend">
        <span>
          <i className="sw takeoff" />起飞 TOW
        </span>
        <span>
          <i className="sw landing" />落地 LW
        </span>
        <span>
          <i className="sw zfw" />零油 ZFW
        </span>
        <span>
          <i className="sw switch" />油箱切换
        </span>
        <span>
          <i className="sw traj" />耗油轨迹
        </span>
        <span>
          <i className="sw viol" />越界段
        </span>
        <span>
          <i className="sw fwd" />前限
        </span>
        <span>
          <i className="sw aft" />后限
        </span>
      </div>
    </section>
  )
}
