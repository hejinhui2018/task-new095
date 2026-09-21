import { useEffect, useMemo, useReducer, useState } from 'react'
import type { DragEvent } from 'react'
import { aircraft } from './lib/aircraft'
import { manifestItems } from './lib/manifest'
import { evaluateLoad } from './lib/limits'
import { evaluateRunway, type PerfInput } from './lib/performance'
import { generateCandidates, type Candidate } from './lib/candidates'
import { buildStationMap } from './lib/weightBalance'
import { historyReducer, loadHistory, saveHistory } from './state/store'
import { CabinLayout } from './components/CabinLayout'
import { ManifestPanel } from './components/ManifestPanel'
import { FuelPanel } from './components/FuelPanel'
import { SummaryPanel } from './components/SummaryPanel'
import { AlertsPanel } from './components/AlertsPanel'
import { EnvelopeChart } from './components/EnvelopeChart'
import { RunwayPanel } from './components/RunwayPanel'
import { CandidatesPanel } from './components/CandidatesPanel'

const stations = buildStationMap(aircraft)

export default function App() {
  const [history, dispatch] = useReducer(historyReducer, undefined, loadHistory)
  const state = history.present
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // 每次调整后持久化（含撤销/重做栈），刷新页面可恢复
  useEffect(() => {
    saveHistory(history)
  }, [history])

  const itemsById = useMemo(() => new Map(manifestItems.map((i) => [i.id, i])), [])
  const computed = useMemo(() => evaluateLoad(aircraft, manifestItems, state), [state])
  const perfResult = useMemo(
    () =>
      evaluateRunway(aircraft, state.perf, {
        takeoffWeight: computed.takeoff.weight,
        landingWeight: computed.landing.weight,
      }),
    [aircraft, state.perf, computed.takeoff.weight, computed.landing.weight],
  )
  const candidateSet = useMemo(
    () => generateCandidates(aircraft, manifestItems, state),
    [aircraft, state],
  )

  const draggingKind = draggingId ? itemsById.get(draggingId)?.kind ?? null : null
  const selectedItem = selectedId ? itemsById.get(selectedId) ?? null : null

  const loadErrors = computed.issues.filter((i) => i.severity === 'error').length
  const warnings = computed.issues.filter((i) => i.severity === 'warning').length
  const perfGo =
    perfResult.ok &&
    perfResult.takeoffLimit != null &&
    perfResult.landingLimit != null &&
    computed.takeoff.weight <= perfResult.takeoffLimit &&
    computed.landing.weight <= perfResult.landingLimit
  const perfRejected = !perfResult.ok
  const errors = loadErrors + (perfGo ? 0 : 1)
  const status =
    errors > 0
      ? {
          cls: 'bad',
          text: perfRejected
            ? `⛔ 不可放行 · 跑道条件超出审定范围`
            : `⛔ 不可放行 · ${loadErrors} 项配载问题 / 跑道限重不足`,
        }
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

  const handlePerfChange = (patch: Partial<PerfInput>) =>
    dispatch({ type: 'setPerf', patch, coalesceKey: 'perf' })
  const handleApplyCandidate = (c: Candidate) => dispatch({ type: 'applyPlan', plan: c.plan })

  const handleReset = () => {
    if (window.confirm('恢复初始航班清单、燃油计划与跑道条件？当前所有调整（含历史）将丢失。')) {
      dispatch({ type: 'reset' })
      setSelectedId(null)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>云雀 K-12 · 配载与跑道放行预演</h1>
          <p className="subtitle">支线航班起飞前重量 / 重心 / 燃油 / 跑道性能预演 · 机型与性能表均为虚构</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="hist-btn"
            onClick={() => dispatch({ type: 'undo' })}
            disabled={!history.past.length}
            title="撤销（滑块连续拖动合并为一步）"
          >
            ↶ 撤销
          </button>
          <button
            type="button"
            className="hist-btn"
            onClick={() => dispatch({ type: 'redo' })}
            disabled={!history.future.length}
            title="重做"
          >
            ↷ 重做
          </button>
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
        {/* 首屏：跑道剖面 / 距离条 + 放行候选 */}
        <div className="perf-row">
          <RunwayPanel
            perf={perfResult}
            input={state.perf}
            computed={computed}
            onChange={handlePerfChange}
          />
          <CandidatesPanel
            candidates={candidateSet.valid}
            invalid={candidateSet.invalid}
            alreadyOk={candidateSet.alreadyOk}
            onApply={handleApplyCandidate}
          />
        </div>

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
            onFuel={(tankId, value) => dispatch({ type: 'setFuel', tankId, value, coalesceKey: 'fuel' })}
            onBurn={(value) => dispatch({ type: 'setBurn', value, coalesceKey: 'burn' })}
          />
          <SummaryPanel aircraft={aircraft} computed={computed} burn={state.burn} />
          <AlertsPanel
            aircraft={aircraft}
            issues={computed.issues}
            perf={perfResult}
            takeoffWeight={computed.takeoff.weight}
            landingWeight={computed.landing.weight}
          />
        </div>
      </main>
    </div>
  )
}
