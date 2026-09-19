import type { DragEvent } from 'react'
import type { Aircraft, BaggageCompartment, LoadItem } from '../lib/types'

type Kind = 'pax' | 'bag'

interface CabinLayoutProps {
  aircraft: Aircraft
  itemsById: Map<string, LoadItem>
  assignments: Record<string, string>
  compartmentTotals: Record<string, number>
  selectedId: string | null
  draggingKind: Kind | null
  onItemClick: (id: string) => void
  onStationClick: (stationId: string) => void
  onDragStartItem: (id: string) => (e: DragEvent) => void
  onDragEnd: () => void
  onDropStation: (stationId: string) => (e: DragEvent) => void
  onDragOverTarget: (kind: Kind) => (e: DragEvent) => void
}

/** 机舱配载图：前行李舱 — 三排座位 — 后行李舱 */
export function CabinLayout(props: CabinLayoutProps) {
  const { aircraft, itemsById, assignments, compartmentTotals, selectedId, draggingKind } = props

  const occupantOf = (seatId: string): LoadItem | null => {
    for (const [itemId, stationId] of Object.entries(assignments)) {
      if (stationId === seatId) return itemsById.get(itemId) ?? null
    }
    return null
  }

  const bagsIn = (compId: string): LoadItem[] =>
    Object.entries(assignments)
      .filter(([, s]) => s === compId)
      .map(([id]) => itemsById.get(id))
      .filter((i): i is LoadItem => !!i)

  const chip = (item: LoadItem) => (
    <button
      type="button"
      key={item.id}
      className={`load-chip ${selectedId === item.id ? 'selected' : ''}`}
      draggable
      onDragStart={props.onDragStartItem(item.id)}
      onDragEnd={props.onDragEnd}
      onClick={(e) => {
        e.stopPropagation()
        props.onItemClick(item.id)
      }}
    >
      {item.name} <span className="chip-wt">{item.weight} lb</span>
    </button>
  )

  const renderCompartment = (comp: BaggageCompartment) => {
    const bags = bagsIn(comp.id)
    const total = compartmentTotals[comp.id] ?? 0
    const over = total > comp.maxWeight
    return (
      <div
        key={comp.id}
        className={`compartment ${over ? 'over' : ''} ${draggingKind === 'bag' ? 'drop-hint' : ''}`}
        onDragOver={props.onDragOverTarget('bag')}
        onDrop={props.onDropStation(comp.id)}
        onClick={() => props.onStationClick(comp.id)}
      >
        <div className="comp-head">
          <span>
            {comp.name} · 臂 {comp.arm} in
          </span>
          <span className={`comp-total ${over ? 'bad' : ''}`}>
            {total} / {comp.maxWeight} lb
          </span>
        </div>
        <div className="comp-items">
          {bags.length === 0 && <span className="comp-empty">空</span>}
          {bags.map(chip)}
        </div>
      </div>
    )
  }

  return (
    <section className="panel cabin-panel">
      <h2>机舱配载</h2>
      <div className="cabin">
        {aircraft.baggageCompartments.filter((c) => c.position === 'forward').map(renderCompartment)}
        <div className="seat-rows">
          {aircraft.rows.map((row) => (
            <div className="seat-row" key={row.id}>
              <div className="row-meta">
                <span>{row.name}</span>
                <span className="row-arm">臂 {row.arm} in</span>
              </div>
              <div className="seats">
                {row.seats.map((seatId) => {
                  const occ = occupantOf(seatId)
                  return (
                    <div
                      key={seatId}
                      className={[
                        'seat',
                        occ ? 'occupied' : '',
                        draggingKind === 'pax' ? 'drop-hint' : '',
                        occ && selectedId === occ.id ? 'selected' : '',
                      ].join(' ')}
                      draggable={!!occ}
                      onDragStart={occ ? props.onDragStartItem(occ.id) : undefined}
                      onDragEnd={props.onDragEnd}
                      onDragOver={props.onDragOverTarget('pax')}
                      onDrop={props.onDropStation(seatId)}
                      onClick={() =>
                        occ && !selectedId ? props.onItemClick(occ.id) : props.onStationClick(seatId)
                      }
                    >
                      <span className="seat-id">{seatId}</span>
                      {occ ? (
                        <>
                          <span className="occ-name">{occ.name}</span>
                          <span className="occ-wt">{occ.weight} lb</span>
                        </>
                      ) : (
                        <span className="seat-empty">空</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        {aircraft.baggageCompartments.filter((c) => c.position === 'aft').map(renderCompartment)}
      </div>
    </section>
  )
}
