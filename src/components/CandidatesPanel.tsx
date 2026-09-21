import type { Candidate, CandidateKind } from '../lib/candidates'

interface CandidatesPanelProps {
  candidates: Candidate[]
  invalid: Candidate[]
  alreadyOk: boolean
  onApply: (c: Candidate) => void
}

const kindLabel: Record<CandidateKind, string> = {
  reduceFuel: '减油',
  offload: '卸载',
  runwayChange: '换跑道',
}

const kindClass: Record<CandidateKind, string> = {
  reduceFuel: 'k-fuel',
  offload: 'k-offload',
  runwayChange: 'k-runway',
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

/** 候选方案面板：按保留业载/燃油余量/改动排序，应用后可撤销重做 */
export function CandidatesPanel({ candidates, invalid, alreadyOk, onApply }: CandidatesPanelProps) {
  return (
    <section className="panel candidates-panel">
      <h2>放行候选</h2>
      {alreadyOk ? (
        <p className="all-ok">✅ 当前方案满足结构、重心与四阶段跑道性能限制，无需调整。</p>
      ) : candidates.length === 0 ? (
        <p className="cand-empty">
          ⛔ 没有可在当前气象/道面下恢复放行的候选（超表界或顺风越界时减油、卸载均无效），
          请更换跑道、调整气象输入或更新性能表版本。
        </p>
      ) : (
        <>
          <p className="hint">按「保留业载 → 落地燃油余量 → 操作改动」排序；应用后可用撤销恢复。</p>
          <ul className="cand-list">
            {candidates.map((c, i) => (
              <li key={c.id} className="cand-item">
                <div className="cand-head">
                  <span className={`cand-kind ${kindClass[c.kind]}`}>{kindLabel[c.kind]}</span>
                  {i === 0 && <span className="cand-best">推荐</span>}
                  <strong className="cand-title">{c.title}</strong>
                  <button type="button" className="cand-apply" onClick={() => onApply(c)}>
                    采用
                  </button>
                </div>
                <ul className="cand-changes">
                  {c.changes.map((ch, j) => (
                    <li key={j}>{ch}</li>
                  ))}
                </ul>
                <div className="cand-metrics">
                  <span>
                    起飞 <strong>{fmt(c.computed.takeoff.weight)}</strong> / 限重{' '}
                    {c.perf.takeoffLimit == null ? '—' : fmt(c.perf.takeoffLimit)} lb
                  </span>
                  <span>
                    落地 <strong>{fmt(c.computed.landing.weight)}</strong> / 限重{' '}
                    {c.perf.landingLimit == null ? '—' : fmt(c.perf.landingLimit)} lb
                  </span>
                  <span>
                    保留业载 <strong>{fmt(c.payloadRetained)}</strong> lb
                  </span>
                  <span>
                    落地剩油 <strong>{fmt(c.fuelReserve)}</strong> lb
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {invalid.length > 0 && (
        <details className="cand-invalid">
          <summary>不可行的尝试（{invalid.length}，不会被采用）</summary>
          <ul>
            {invalid.map((c) => (
              <li key={c.id}>
                <span className="cand-title">{c.title}</span>
                <span className="detail bad">{c.invalidReasons.join('；')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
