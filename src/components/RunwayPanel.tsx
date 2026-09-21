import type { PerfInput } from '../lib/performance'
import type { ResolvedPerf } from '../lib/performance'
import { airports } from '../lib/airports'
import { MAX_CROSSWIND_KT, MAX_HEADWIND_KT, MAX_TAILWIND_KT } from '../lib/perfTables'

interface RunwayPanelProps {
  perf: PerfInput
  resolved: ResolvedPerf | null
  onPatch: (patch: Partial<PerfInput>, coalesceKey?: string) => void
}

const num = (v: string): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 跑道性能输入：机场/跑道/方向/干湿 + 温度/气压高度/风/坡度/障碍物（标注来源） */
export function RunwayPanel({ perf, resolved, onPatch }: RunwayPanelProps) {
  const airport = airports.find((a) => a.id === perf.airportId) ?? airports[0]
  const runway = airport.runways.find((r) => r.id === perf.runwayId) ?? airport.runways[0]
  const end = runway.ends.find((e) => e.id === perf.endId) ?? runway.ends[0]

  const selectAirport = (airportId: string) => {
    const ap = airports.find((a) => a.id === airportId)!
    const rw = ap.runways[0]
    onPatch({
      airportId: ap.id,
      runwayId: rw.id,
      endId: rw.ends[0].id,
      pressureAltFt: ap.elevationFt,
      slopeOverridePct: null,
      obstacleOverride: null,
    })
  }
  const selectRunway = (runwayId: string) => {
    const rw = airport.runways.find((r) => r.id === runwayId)!
    onPatch({ runwayId: rw.id, endId: rw.ends[0].id, slopeOverridePct: null, obstacleOverride: null })
  }
  const selectEnd = (endId: string) => {
    onPatch({ endId, slopeOverridePct: null, obstacleOverride: null })
  }

  const wind = resolved?.wind
  const hw = wind?.headwindKt ?? 0
  const xw = wind?.crosswindKt ?? 0
  const windBad =
    !wind || hw > MAX_HEADWIND_KT || -hw > MAX_TAILWIND_KT || xw > MAX_CROSSWIND_KT
  const slopeIsLib = perf.slopeOverridePct === null
  const obIsLib = perf.obstacleOverride === null
  const ob = perf.obstacleOverride ?? end.defaultObstacle
  const paIsLib = perf.pressureAltFt === airport.elevationFt

  return (
    <section className="panel runway-panel">
      <h2>跑道性能放行</h2>
      <div className="perf-grid">
        <label>
          <span>机场</span>
          <select value={airport.id} onChange={(e) => selectAirport(e.target.value)}>
            {airports.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>跑道</span>
          <select value={runway.id} onChange={(e) => selectRunway(e.target.value)}>
            {airport.runways.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>使用方向</span>
          <select value={end.id} onChange={(e) => selectEnd(e.target.value)}>
            {runway.ends.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}（{e.heading}°）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>道面</span>
          <div className="seg">
            <button
              type="button"
              className={perf.surface === 'dry' ? 'on' : ''}
              onClick={() => onPatch({ surface: 'dry' }, 'surface')}
            >
              干
            </button>
            <button
              type="button"
              className={perf.surface === 'wet' ? 'on' : ''}
              onClick={() => onPatch({ surface: 'wet' }, 'surface')}
            >
              湿
            </button>
          </div>
        </label>

        <label>
          <span>
            外界温度 °C
            <em className="src user">气象观测</em>
          </span>
          <input
            type="number"
            step={1}
            value={perf.oatC}
            onChange={(e) => onPatch({ oatC: num(e.target.value) }, 'oat')}
          />
        </label>
        <label>
          <span>
            气压高度 ft
            <em className={`src ${paIsLib ? 'library' : 'user'}`}>{paIsLib ? '机场标高' : '人工修正'}</em>
          </span>
          <div className="input-with-btn">
            <input
              type="number"
              step={10}
              value={perf.pressureAltFt}
              onChange={(e) => onPatch({ pressureAltFt: num(e.target.value) }, 'pa')}
            />
            {!paIsLib && (
              <button type="button" onClick={() => onPatch({ pressureAltFt: airport.elevationFt })}>
                取标高
              </button>
            )}
          </div>
        </label>

        <label>
          <span>风向 °磁</span>
          <input
            type="number"
            step={5}
            value={perf.windDirDeg}
            onChange={(e) => onPatch({ windDirDeg: num(e.target.value), windSpeedKt: perf.windSpeedKt || 0 }, 'wind')}
          />
        </label>
        <label>
          <span>风速 kt</span>
          <input
            type="number"
            step={1}
            min={0}
            value={perf.windSpeedKt}
            onChange={(e) => onPatch({ windSpeedKt: Math.max(0, num(e.target.value)) }, 'wind')}
          />
        </label>
      </div>

      {wind && (
        <div className={`wind-readout ${windBad ? 'bad' : ''}`}>
          {perf.windSpeedKt === 0 ? (
            <>静风</>
          ) : (
            <>
              {hw >= 0 ? `顶风 ${hw.toFixed(1)} kt` : `顺风 ${(-hw).toFixed(1)} kt`} · 侧风{' '}
              {xw.toFixed(1)} kt（{xw === 0 ? '无' : wind.crossSide === 'right' ? '右侧' : '左侧'}）
            </>
          )}
          <em>
            批准边界：顶风 ≤{MAX_HEADWIND_KT} / 顺 ≤{MAX_TAILWIND_KT} / 侧 ≤{MAX_CROSSWIND_KT} kt
          </em>
        </div>
      )}

      <div className="perf-overrides">
        <label className="override-row">
          <input
            type="checkbox"
            checked={slopeIsLib}
            onChange={(e) =>
              onPatch({ slopeOverridePct: e.target.checked ? null : end.slopePct })
            }
          />
          <span>
            坡度采用跑道库值
            <em className="src library">{end.slopePct}%</em>
          </span>
          {!slopeIsLib && (
            <input
              type="number"
              step={0.1}
              value={perf.slopeOverridePct ?? 0}
              onChange={(e) => onPatch({ slopeOverridePct: num(e.target.value) }, 'slope')}
            />
          )}
          {!slopeIsLib && <em className="pct">%</em>}
        </label>

        <label className="override-row">
          <input
            type="checkbox"
            checked={obIsLib}
            onChange={(e) =>
              onPatch({ obstacleOverride: e.target.checked ? null : { ...end.defaultObstacle } })
            }
          />
          <span>
            障碍物采用跑道库值
            <em className="src library">
              {end.defaultObstacle.heightFt} ft / {end.defaultObstacle.distanceFt.toLocaleString()} ft
            </em>
          </span>
        </label>
        {!obIsLib && (
          <div className="obstacle-inputs">
            <label>
              <span>高 ft</span>
              <input
                type="number"
                step={5}
                value={ob.heightFt}
                onChange={(e) =>
                  onPatch({ obstacleOverride: { ...ob, heightFt: num(e.target.value) } }, 'obstacle')
                }
              />
            </label>
            <label>
              <span>距起飞端 ft</span>
              <input
                type="number"
                step={50}
                value={ob.distanceFt}
                onChange={(e) =>
                  onPatch({ obstacleOverride: { ...ob, distanceFt: Math.max(0, num(e.target.value)) } }, 'obstacle')
                }
              />
            </label>
          </div>
        )}
      </div>
    </section>
  )
}
