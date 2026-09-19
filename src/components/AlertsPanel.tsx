import type { Aircraft } from '../lib/types'
import type { Issue } from '../lib/limits'
import { phaseLabel } from '../lib/trajectory'

interface AlertsPanelProps {
  aircraft: Aircraft
  issues: Issue[]
}

/** 限制检查：按优先级列出全部问题，含首次越界阶段与可追溯载荷贡献 */
export function AlertsPanel({ aircraft, issues }: AlertsPanelProps) {
  return (
    <section className="panel alerts-panel">
      <h2>限制检查</h2>
      {issues.length === 0 ? (
        <p className="all-ok">✅ 所有限制检查通过，可以放行。</p>
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
