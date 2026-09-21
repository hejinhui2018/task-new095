import type { PerformanceReport, PerfStage, StageResult } from '../lib/performance'
import { STAGE_LABELS } from '../lib/performance'
import type { ControllingStage } from '../lib/performance'

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

const CONTROL_LABEL: Record<ControllingStage['stage'], string> = {
  tod: '起飞滑跑',
  'climb-all': '全发越障',
  'climb-oei': '单发越障',
  landing: '着陆距离',
  mtow: '结构 MTOW',
  mlw: '结构 MLW',
}

const STAGE_ORDER: PerfStage[] = ['tod', 'climb-all', 'climb-oei', 'landing']

/** 四类限重、控制阶段与裕量；被拒绝的阶段给出明确原因与修正追溯 */
export function PerfResultsPanel({
  report,
  takeoffWeight,
  landingWeight,
}: {
  report: PerformanceReport
  takeoffWeight: number
  landingWeight: number
}) {
  return (
    <section className="panel perf-results">
      <h2>
        性能限重
        <span className="table-version">性能表 {report.version}</span>
      </h2>

      <div className="control-banner">
        <ControlBanner report={report} takeoffWeight={takeoffWeight} landingWeight={landingWeight} />
      </div>

      <table className="perf-table">
        <thead>
          <tr>
            <th>阶段</th>
            <th>生效限重 lb</th>
            <th>实际重量 lb</th>
            <th>裕量 lb</th>
            <th>判定</th>
          </tr>
        </thead>
        <tbody>
          {STAGE_ORDER.map((s) => (
            <StageRow
              key={s}
              stage={report.stages[s]}
              actualWeight={s === 'landing' ? landingWeight : takeoffWeight}
              controlling={
                report.controllingTakeoff?.stage === s || report.controllingLanding?.stage === s
              }
            />
          ))}
        </tbody>
      </table>

      <div className="rejection-list">
        {report.rejections.map((r, i) => (
          <div key={i} className="rejection">
            <span className="icon">⛔</span>
            <div>
              <strong>{STAGE_LABELS[r.stage]}拒绝</strong>
              <p>{r.message}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ControlBanner({
  report,
  takeoffWeight,
  landingWeight,
}: {
  report: PerformanceReport
  takeoffWeight: number
  landingWeight: number
}) {
  const to = report.controllingTakeoff
  const ld = report.controllingLanding
  return (
    <>
      <div className={`control-item ${to && takeoffWeight <= to.effectiveLimitLb ? 'ok' : 'bad'}`}>
        <span className="control-label">起飞控制阶段</span>
        {to ? (
          <span>
            <strong>{CONTROL_LABEL[to.stage]}</strong> · 限重 {fmt(to.effectiveLimitLb)} lb ·{' '}
            {takeoffWeight <= to.effectiveLimitLb ? '裕量' : '超出'}{' '}
            <em>{fmt(Math.abs(to.effectiveLimitLb - takeoffWeight))}</em> lb
          </span>
        ) : (
          <span>
            <strong>无有效限重</strong>（一个或多个起飞阶段被拒绝，不能放行）
          </span>
        )}
      </div>
      <div className={`control-item ${ld && landingWeight <= ld.effectiveLimitLb ? 'ok' : 'bad'}`}>
        <span className="control-label">着陆控制阶段</span>
        {ld ? (
          <span>
            <strong>{CONTROL_LABEL[ld.stage]}</strong> · 限重 {fmt(ld.effectiveLimitLb)} lb ·{' '}
            {landingWeight <= ld.effectiveLimitLb ? '裕量' : '超出'}{' '}
            <em>{fmt(Math.abs(ld.effectiveLimitLb - landingWeight))}</em> lb
          </span>
        ) : (
          <span>
            <strong>无有效限重</strong>（着陆阶段被拒绝）
          </span>
        )}
      </div>
    </>
  )
}

function StageRow({
  stage,
  actualWeight,
  controlling,
}: {
  stage: StageResult
  actualWeight: number
  controlling: boolean
}) {
  if (stage.status === 'rejected') {
    return (
      <>
        <tr className="rejected-row">
          <td>{STAGE_LABELS[stage.stage]}</td>
          <td colSpan={3} className="rejected-cell">
            拒绝：{stage.message}
          </td>
          <td>
            <span className="bad">✗</span>
          </td>
        </tr>
        {stage.correctionTrace.length > 0 && (
          <tr className="trace-row">
            <td colSpan={5}>
              <ol className="inline-trace">
                {stage.correctionTrace.map((s, i) => (
                  <li key={i}>{s.label}</li>
                ))}
              </ol>
            </td>
          </tr>
        )}
      </>
    )
  }
  const ok = stage.marginLb >= 0
  return (
    <>
      <tr className={controlling ? 'controlling' : ''}>
        <td>
          {STAGE_LABELS[stage.stage]}
          {controlling && <span className="control-tag">控制</span>}
        </td>
        <td>
          {fmt(stage.effectiveLimitLb)}
          <span className="limit">
            {' '}
            (表 {fmt(stage.perfLimitLb)}
            {stage.perfLimitLb > stage.structuralCapLb ? ` / 结构 ${fmt(stage.structuralCapLb)}` : ''})
          </span>
        </td>
        <td>{fmt(actualWeight)}</td>
        <td className={ok ? 'ok-text' : 'bad-text'}>
          {ok ? '+' : ''}
          {fmt(stage.marginLb)}
        </td>
        <td>{ok ? <span className="ok-text">✓</span> : <span className="bad-text">✗</span>}</td>
      </tr>
      {stage.correctionTrace.length > 0 && (
        <tr className="trace-row">
          <td colSpan={5}>
            <span className="trace-label">修正顺序：</span>
            {stage.correctionTrace.map((s, i) => (
              <span key={i} className="trace-step">
                {s.label} <em>×{s.cumulative.toFixed(3)}</em>
                {i < stage.correctionTrace.length - 1 ? ' → ' : ''}
              </span>
            ))}
            <span className="basis"> · {stage.basis}</span>
          </td>
        </tr>
      )}
    </>
  )
}
