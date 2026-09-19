import { useEffect, useMemo, useReducer, useState } from 'react'
import type { DragEvent } from 'react'
import { aircraft } from './lib/aircraft'
import { manifestItems } from './lib/manifest'
import { evaluateLoad } from './lib/limits'
import { buildStationMap } from './lib/weightBalance'
import { loadState, reducer, saveState } from './state/store'
import { CabinLayout } from './components/CabinLayout'
import { ManifestPanel } from './components/ManifestPanel'
import { FuelPanel } from './components/FuelPanel'
import { SummaryPanel } from './components/SummaryPanel'
import { AlertsPanel } from './components/AlertsPanel'
import { EnvelopeChart } from './components/EnvelopeChart'

const stations = buildStationMap(aircraft)

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, loadState)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // 每次调整后持久化，刷新页面可恢复当前方案
  useEffect(() => {
    saveState(state)
  }, [state])

  const itemsById = useMemo(() => new Map(manifestItems.map((i) => [i.id, i])), [])
  const computed = useMemo(() => evaluateLoad(aircraft, manifestItems, state), [state])

  const draggingKind = draggingId ? itemsById.get(draggingId)?.kind ?? null : null
  const selectedItem = selectedId ? itemsById.get(selectedId) ?? null : null

  const errors = computed.issues.filter((i) => i.severity === 'error').length
  const warnings = computed.issues.filter((i) => i.severity === 'warning').length
  const status =
    errors > 0
      ? { cls: 'bad', text: `⛔ 不可放行 · ${errors} 项问题` }
      : warnings > 0
        ? { cls: 'warn', text: `⚠️ 可放行 · ${warnings} 项提醒` }
        : { cls: 'ok', text: '✅ 可以放行' }

  // ---- 拖拽 ----
  const handleDragStart = (id: string) => (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingId(id)
  }
  const handleDragEnd = () => setDraggingId(null)
  const handleDropTo = (stationId: string) => (e: DragEvent) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id && itemsById.has(id)) dispatch({ type: 'assign', itemId: id, stationId })
    setDraggingId(null)
  }
  const handleDropUnassign = (e: DragEvent) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id && itemsById.has(id)) dispatch({ type: 'unassign', itemId: id })
    setDraggingId(null)
  }
  const allowDropKind = (kind: 'pax' | 'bag') => (e: DragEvent) => {
    if (draggingKind === kind) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    }
  }
  const allowDropAny = (e: DragEvent) => {
    if (draggingId) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    }
  }

  // ---- 点击放置 ----
  const handleItemClick = (id: string) => setSelectedId((cur) => (cur === id ? null : id))
  const handleStationClick = (stationId: string) => {
    if (!selectedId) return
    dispatch({ type: 'assign', itemId: selectedId, stationId })
    setSelectedId(null)
  }

  const handleReset = () => {
    if (window.confirm('恢复初始航班清单与燃油计划？当前所有调整将丢失。')) {
      dispatch({ type: 'reset' })
      setSelectedId(null)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>云雀 K-12 · 配载预演</h1>
          <p className="subtitle">支线航班起飞前重量 / 重心 / 燃油预演 · 机型数据为虚构</p>
        </div>
        <div className="header-actions">
          <span className={`status-badge ${status.cls}`}>{status.text}</span>
          <button type="button" className="reset-btn" onClick={handleReset}>
            恢复初始航班
          </button>
        </div>
      </header>

      {selectedItem && (
        <div className="selection-hint">
          已选中 <strong>{selectedItem.name}</strong>（{selectedItem.weight} lb，
          {selectedItem.kind === 'pax' ? '乘客' : '行李'}）—— 点击
          {selectedItem.kind === 'pax' ? '座位' : '行李舱'}放置，或拖到目标位置；再次点击取消选中。
        </div>
      )}

      <main className="layout">
        <ManifestPanel
          items={manifestItems}
          assignments={state.assignments}
          stationName={(id) => stations.get(id)?.name ?? id}
          selectedId={selectedId}
          draggingId={draggingId}
          onItemClick={handleItemClick}
          onDragStartItem={handleDragStart}
          onDragEnd={handleDragEnd}
          onDropUnassign={handleDropUnassign}
          onAllowDrop={allowDropAny}
        />
        <div className="center-col">
          <CabinLayout
            aircraft={aircraft}
            itemsById={itemsById}
            assignments={state.assignments}
            compartmentTotals={computed.compartmentTotals}
            selectedId={selectedId}
            draggingKind={draggingKind}
            onItemClick={handleItemClick}
            onStationClick={handleStationClick}
            onDragStartItem={handleDragStart}
            onDragEnd={handleDragEnd}
            onDropStation={handleDropTo}
            onDragOverTarget={allowDropKind}
          />
          <EnvelopeChart aircraft={aircraft} computed={computed} />
        </div>
        <div className="side-col">
          <FuelPanel
            aircraft={aircraft}
            fuel={state.fuel}
            burn={state.burn}
            computed={computed}
            onFuel={(tankId, value) => dispatch({ type: 'setFuel', tankId, value })}
            onBurn={(value) => dispatch({ type: 'setBurn', value })}
          />
          <SummaryPanel aircraft={aircraft} computed={computed} burn={state.burn} />
          <AlertsPanel aircraft={aircraft} issues={computed.issues} />
        </div>
      </main>
    </div>
  )
}
