import type { DragEvent } from 'react'
import type { LoadItem } from '../lib/types'

interface ManifestPanelProps {
  items: LoadItem[]
  assignments: Record<string, string>
  stationName: (id: string) => string
  selectedId: string | null
  draggingId: string | null
  onItemClick: (id: string) => void
  onDragStartItem: (id: string) => (e: DragEvent) => void
  onDragEnd: () => void
  onDropUnassign: (e: DragEvent) => void
  onAllowDrop: (e: DragEvent) => void
}

/** 航班清单：全部乘客与行李，显示当前装载位置；拖到「未装载区」可卸下 */
export function ManifestPanel(props: ManifestPanelProps) {
  const { items, assignments, stationName, selectedId, draggingId } = props
  const unassignedCount = items.filter((i) => !assignments[i.id]).length
  return (
    <section className="panel manifest-panel">
      <h2>航班清单</h2>
      <p className="hint">拖动乘客到座位、行李到行李舱；或点击选中后点击目标位置。</p>
      <div
        className={`unassigned-zone ${draggingId ? 'active' : ''}`}
        onDragOver={props.onAllowDrop}
        onDrop={props.onDropUnassign}
      >
        未装载区（拖到此处卸下）
        {unassignedCount > 0 && <strong> · 当前 {unassignedCount} 项未装载</strong>}
      </div>
      <ul className="manifest-list">
        {items.map((item) => {
          const stationId = assignments[item.id]
          return (
            <li
              key={item.id}
              className={`${selectedId === item.id ? 'selected' : ''} ${stationId ? '' : 'unassigned'}`}
              draggable
              onDragStart={props.onDragStartItem(item.id)}
              onDragEnd={props.onDragEnd}
              onClick={() => props.onItemClick(item.id)}
            >
              <span className={`kind ${item.kind}`}>{item.kind === 'pax' ? '客' : '行'}</span>
              <span className="name">{item.name}</span>
              <span className="wt">{item.weight} lb</span>
              <span className={`loc ${stationId ? '' : 'none'}`}>
                {stationId ? stationName(stationId) : '未装载'}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
