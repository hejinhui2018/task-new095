import { useEffect, useDeferredValue, useMemo, useReducer, useState } from 'react'
import type { DragEvent } from 'react'
import { aircraft } from './lib/aircraft'
import { manifestItems } from './lib/manifest'
import { evaluateLoad, categoryPriority } from './lib/limits'
import { evaluatePerformance } from './lib/performance'
import { performanceIssues } from './lib/performanceIssues'
import { generateCandidates } from './lib/candidates'
import { buildStationMap } from './lib/weightBalance'
import { appReducer, loadHistory, saveAppState } from './state/appStore'
import type { Candidate } from './lib/candidates'
import { CabinLayout } from './components/CabinLayout'
import { ManifestPanel } from './components/ManifestPanel'
import { FuelPanel } from './components/FuelPanel'
import { SummaryPanel } from './components/SummaryPanel'
import { AlertsPanel } from './components/AlertsPanel'
import { EnvelopeChart } from './components/EnvelopeChart'
import { RunwayPanel } from './components/RunwayPanel'
import { RunwayProfile } from './components/RunwayProfile'
import { PerfResultsPanel } from './components/PerfResultsPanel'
import { CandidatePanel } from './components/CandidatePanel'

const stations = buildStationMap(aircraft)

export default function App() {
  const [history, dispatch] = useReducer(appReducer, undefined, loadHistory)
  const state = history.present
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [appliedHint, setAppliedHint] = useState<string | null>(null)

  // 每次调整后持久化，刷新页面可恢复当前方案（v2：配载 + 跑道性能输入）
  useEffect(() => {
    saveAppState(state)
  }, [state])

  // 滑块/数值连续输入结束后（失焦）结束合并，使下一次调整成为新的历史条目
  useEffect(() => {
    const breakMerge = () => dispatch({ type: 'breakCoalesce' })
    window.addEventListener('pointerup', breakMerge)
    return () => window.removeEventListener('pointerup', breakMerge)
  }, [])

  // 撤销/重做快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        dispatch({ type: 'undo' })
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault()
        dispatch({ type: 'redo' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const itemsById = useMemo(() => new Map(manifestItems.map((i) => [i.id, i])), [])
  const computed = useMemo(() => evaluateLoad(aircraft, manifestItems, state.plan), [state.plan])
  const report = useMemo(
    () =>
      evaluatePerformance(aircraft, state.perf, {
        takeoffLb: computed.takeoff.weight,
        landingLb: computed.landing.weight,
      }),
    [state.perf, computed.takeoff.weight, computed.landing.weight],
  )
  // 候选枚举较重（全量复验每个卸载组合），用 deferred 值避免拖动滑块时卡输入
  const deferredPlan = useDeferredValue(state.plan)
  const deferredPerf = useDeferredValue(state.perf)
  const candidatesStale = deferredPlan !== state.plan || deferredPerf !== state.perf
  const candidateSet = useMemo(
    () => generateCandidates(aircraft, manifestItems, deferredPlan, deferredPerf),
    [deferredPlan, deferredPerf],
  )

  const allIssues = useMemo(() => {
    const perfIssues = performanceIssues(
      report,
      computed.takeoff.weight,
      computed.landing.weight,
    )
    return [...computed.issues, ...perfIssues].sort(
      (a, b) =>
        categoryPriority[a.category] - categoryPriority[b.category] ||
        (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1),
    )
  }, [report, computed])

  const errors = allIssues.filter((i) => i.severity === 'error').length
  const warnings = allIssues.filter((i) => i.severity === 'warning').length
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
    if (window.confirm('恢复初始航班清单、燃油计划与短湿跑道示例？当前所有调整将丢失（可用撤销恢复）。')) {
      dispatch({ type: 'reset' })
      setSelectedId(null)
    }
  }

  const handleApplyCandidate = (c: Candidate) => {
    dispatch({ type: 'applyCandidate', state: { plan: c.plan, perf: c.perf } })
    setSelectedId(null)
    setAppliedHint(`已采用候选：${c.title}（可撤销）`)
    window.setTimeout(() => setAppliedHint(null), 4000)
  }

  const draggingKind = draggingId ? itemsById.get(draggingId)?.kind ?? null : null
  const selectedItem = selectedId ? itemsById.get(selectedId) ?? null : null

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>云雀 K-12 · 配载与跑道性能预演</h1>
          <p className="subtitle">
            支线航班起飞前重量 / 重心 / 燃油 / 跑道限重预演 · 机型与性能表数据均为虚构
          </p>
        </div>
        <div className="header-actions">
          <span className={`status-badge ${status.cls}`}>{status.text}</span>
          <button
            type="button"
            className="hist-btn"
            onClick={() => dispatch({ type: 'undo' })}
            disabled={history.past.length === 0}
            title="撤销（Ctrl+Z）"
          >
            ↶ 撤销
          </button>
          <button
            type="button"
            className="hist-btn"
            onClick={() => dispatch({ type: 'redo' })}
            disabled={history.future.length === 0}
            title="重做（Ctrl+Y）"
          >
            ↷ 重做
          </button>
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
      {appliedHint && <div className="applied-hint">{appliedHint}</div>}

      <main className="layout">
        <ManifestPanel
          items={manifestItems}
          assignments={state.plan.assignments}
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
          <RunwayProfile report={report} />
          <CandidatePanel
            set={candidateSet}
            alreadyOk={errors === 0}
            stale={candidatesStale}
            onApply={handleApplyCandidate}
          />
          <CabinLayout
            aircraft={aircraft}
            itemsById={itemsById}
            assignments={state.plan.assignments}
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
          <RunwayPanel
            perf={state.perf}
            resolved={report.resolved}
            onPatch={(patch, key) => dispatch({ type: 'setPerf', patch, coalesceKey: key })}
          />
          <PerfResultsPanel
            report={report}
            takeoffWeight={computed.takeoff.weight}
            landingWeight={computed.landing.weight}
          />
          <FuelPanel
            aircraft={aircraft}
            fuel={state.plan.fuel}
            burn={state.plan.burn}
            computed={computed}
            onFuel={(tankId, value) =>
              dispatch({ type: 'setFuel', tankId, value, coalesceKey: `fuel-${tankId}` })
            }
            onBurn={(value) => dispatch({ type: 'setBurn', value, coalesceKey: 'burn' })}
          />
          <SummaryPanel aircraft={aircraft} computed={computed} burn={state.plan.burn} />
          <AlertsPanel aircraft={aircraft} issues={allIssues} />
        </div>
      </main>
    </div>
  )
}
