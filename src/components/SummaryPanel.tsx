import type { Aircraft } from '../lib/types'
import type { Computed } from '../lib/limits'
import { cgOf } from '../lib/weightBalance'
import { cgLimitsAt } from '../lib/envelope'

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')
const fmt1 = (n: number): string => n.toFixed(1)

interface SummaryPanelProps {
  aircraft: Aircraft
  computed: Computed
  burn: number
}

/** 数值摘要：零油/起飞/落地三阶段的重量、力矩、重心与限制判定 */
export function SummaryPanel({ aircraft, computed, burn }: SummaryPanelProps) {
  const rows = [
    { label: '零油重量 ZFW', wm: computed.zfw, limit: aircraft.mzfw, limitName: 'MZFW' },
    { label: '起飞重量 TOW', wm: computed.takeoff, limit: aircraft.mtow, limitName: 'MTOW' },
    { label: '落地重量 LW', wm: computed.landing, limit: aircraft.mlw, limitName: 'MLW' },
  ]
  return (
    <section className="panel summary-panel">
      <h2>数值摘要</h2>
      <table className="summary">
        <thead>
          <tr>
            <th>阶段</th>
            <th>重量 lb</th>
            <th>力矩 lb·in</th>
            <th>重心 in</th>
            <th>重心包线 in</th>
            <th>判定</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cg = cgOf(r.wm)
            const limits = cgLimitsAt(aircraft.envelope, r.wm.weight)
            const wOk = r.wm.weight <= r.limit
            const cgOk = cg >= limits.forward && cg <= limits.aft
            return (
              <tr key={r.label}>
                <td>
                  {r.label}
                  <span className="limit-tag">{r.limitName}</span>
                </td>
                <td className={wOk ? '' : 'bad'}>
                  {fmt(r.wm.weight)} <span className="limit">/ {fmt(r.limit)}</span>
                </td>
                <td>{fmt(r.wm.moment)}</td>
                <td className={cgOk ? '' : 'bad'}>{fmt1(cg)}</td>
                <td className="limit">
                  {fmt1(limits.forward)} ~ {fmt1(limits.aft)}
                </td>
                <td>{wOk && cgOk ? <span className="ok">✓</span> : <span className="bad">✗</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="fuel-summary">
        机载燃油 {fmt(computed.totalFuel)} lb · 预计耗油 {fmt(burn)} lb · 落地剩油{' '}
        {fmt(computed.totalFuel - computed.burnedTotal)} lb
      </div>
    </section>
  )
}
