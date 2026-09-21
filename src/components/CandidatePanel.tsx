import type { Candidate, CandidateSet } from '../lib/candidates'
import { CANDIDATE_KIND_LABEL } from '../lib/candidates'

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

interface CandidatePanelProps {
  set: CandidateSet
  alreadyOk: boolean
  stale?: boolean
  onApply: (c: Candidate) => void
}

const KIND_CLASS: Record<Candidate['kind'], string> = {
  runway: 'kind-runway',
  'reduce-fuel': 'kind-fuel',
  offload: 'kind-offload',
  mixed: 'kind-mixed',
}

/** 候选方案列表：按保留业载 / 落地油量 / 操作改动排序，采用前可查看每项裕量与改动 */
export function CandidatePanel({ set, alreadyOk, stale, onApply }: CandidatePanelProps) {
  return (
    <section className={`panel candidate-panel ${stale ? 'stale' : ''}`}>
      <h2>
        放行候选方案
        {stale && <span className="table-version">正在按新条件重算…</span>}
      </h2>
      <p className="hint">
        候选均已按当前跑道条件全量复验（结构重量、重心轨迹、起飞/着陆限重），按
        <strong> 保留业载 → 落地燃油余量 → 操作改动数</strong> 排序。
      </p>
      {alreadyOk ? (
        <p className="all-ok">✅ 当前方案满足全部结构与跑道性能限制，无需调整。</p>
      ) : set.candidates.length === 0 ? (
        <div className="no-candidate">
          <strong>未找到可放行的配载调整。</strong>
          <span>
            {set.onlyRunwaySwitch
              ? '当前问题不是减油/卸载可以解决的（温度或气压高度超出表格范围、顺/侧风越界或无越障数据）。请更换跑道/方向、等待天气改善，或确认无经批准数据后拒绝放行。'
              : '请检查跑道条件或人工输入。'}
          </span>
        </div>
      ) : (
        <ol className="candidate-list">
          {set.candidates.map((c, i) => (
            <li key={c.id} className="candidate-card">
              <div className="candidate-head">
                <span className={`candidate-kind ${KIND_CLASS[c.kind]}`}>
                  {CANDIDATE_KIND_LABEL[c.kind]}
                </span>
                <span className="candidate-rank">#{i + 1}</span>
                <strong className="candidate-title">{c.title}</strong>
                <button type="button" className="apply-btn" onClick={() => onApply(c)}>
                  采用
                </button>
              </div>
              <ul className="candidate-changes">
                {c.changes.map((line, j) => (
                  <li key={j}>{line}</li>
                ))}
              </ul>
              <div className="candidate-metrics">
                <span>
                  保留业载 <em>{fmt(c.retainedPayloadLb)}</em> lb
                </span>
                <span>
                  落地剩油 <em>{fmt(c.landingFuelLb)}</em> lb
                </span>
                <span>
                  操作改动 <em>{c.opsChanges}</em> 项
                </span>
                <span className={c.takeoffMarginLb >= 0 ? 'ok-text' : 'bad-text'}>
                  起飞裕量 +{fmt(c.takeoffMarginLb)}
                </span>
                <span className={c.landingMarginLb >= 0 ? 'ok-text' : 'bad-text'}>
                  着陆裕量 +{fmt(c.landingMarginLb)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
