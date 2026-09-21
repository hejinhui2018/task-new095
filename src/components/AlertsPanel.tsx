import type { Aircraft } from '../lib/types'
import type { Issue } from '../lib/limits'
import { phaseLabel } from '../lib/trajectory'
import { phaseNames, phaseOrder, type PerfResult } from '../lib/performance'

interface AlertsPanelProps {
  aircraft: Aircraft
  issues: Issue[]
  perf?: PerfResult
  takeoffWeight?: number
  landingWeight?: number
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

/** 限制检查：按优先级列出配载问题，并汇总跑道性能放行结论 */
export function AlertsPanel({ aircraft, issues, perf, takeoffWeight, landingWeight }: AlertsPanelProps) {
  const perfProblems: { severity: 'error' | 'warning'; message: string }[] = []
  if (perf) {
    for (const id of phaseOrder) {
      const p = perf.phases[id]
      if (p.status === 'rejected' && p.error) {
        perfProblems.push({ severity: 'error', message: `${phaseNames[id]}：${p.error.message}` })
      }
    }
    if (perf.ok) {
      if (perf.takeoffLimit != null && takeoffWeight != null && takeoffWeight > perf.takeoffLimit) {
        perfProblems.push({
          severity: 'error',
          message: `起飞重量 ${fmt(takeoffWeight)} lb 超过跑道起飞限重 ${fmt(perf.takeoffLimit)} lb（${
            perf.takeoffControllingPhase ? phaseNames[perf.takeoffControllingPhase] : ''
          }控制，超出 ${fmt(takeoffWeight - perf.takeoffLimit)} lb）`,
        })
      }
      if (perf.landingLimit != null && landingWeight != null && landingWeight > perf.landingLimit) {
        perfProblems.push({
          severity: 'error',
          message: `落地重量 ${fmt(landingWeight)} lb 超过着陆限重 ${fmt(perf.landingLimit)} lb（超出 ${fmt(
            landingWeight - perf.landingLimit,
          )} lb）`,
        })
      }
    }
  }

  return (
    <section className="panel alerts-panel">
      <h2>限制检查</h2>

      {perf && (
        <div className={`perf-alert ${perfProblems.length === 0 ? 'ok' : 'bad'}`}>
          {perf.fatalError ? (
            <span>⛔ {perf.fatalError.message}</span>
          ) : perfProblems.length === 0 ? (
            <span>
              ✈️ 跑道性能（{perf.perfVersion}）：起飞限重{' '}
              {perf.takeoffLimit == null ? '—' : `${fmt(perf.takeoffLimit)} lb`} · 着陆限重{' '}
              {perf.landingLimit == null ? '—' : `${fmt(perf.landingLimit)} lb`}，重量与四阶段限制均满足。
            </span>
          ) : (
            <ul className="perf-alert-list">
              {perfProblems.map((x, i) => (
                <li key={i}>{x.severity === 'error' ? '⛔' : '⚠️'} {x.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {issues.length === 0 && perfProblems.length === 0 ? (
        <p className="all-ok">✅ 所有结构、重心与跑道性能检查通过，可以放行。</p>
      ) : (
        <ul className="issues">
          {issues.map((issue) => (
            <li key={issue.id} className={issue.severity}>
              <div className="issue-head">
                <span className="icon">{issue.severity === 'error' ? '⛔' : '⚠️'}</span>
                <span>{issue.message}</span>
              </div>
              {issue.phase && (
                <div className="issue-phase">
                  首次越界阶段：{phaseLabel(issue.phase, aircraft.fuelTanks)}
                </div>
              )}
              {issue.contributors.length > 0 && (
                <ul className="contributors">
                  {issue.contributors.map((c, i) => (
                    <li key={i}>
                      <span>{c.label}</span>
                      <span className="detail">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
