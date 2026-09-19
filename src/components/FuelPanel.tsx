import type { Aircraft } from '../lib/types'
import type { Computed } from '../lib/limits'

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

interface FuelPanelProps {
  aircraft: Aircraft
  fuel: Record<string, number>
  burn: number
  computed: Computed
  onFuel: (tankId: string, value: number) => void
  onBurn: (value: number) => void
}

/** 燃油面板：各油箱载油量（按耗油顺序展示）与预计航程耗油 */
export function FuelPanel({ aircraft, fuel, burn, computed, onFuel, onBurn }: FuelPanelProps) {
  const totalCapacity = aircraft.fuelTanks.reduce((s, t) => s + t.capacity, 0)
  return (
    <section className="panel fuel-panel">
      <h2>燃油</h2>
      {aircraft.fuelTanks.map((tank, i) => (
        <div className="tank-row" key={tank.id}>
          <div className="tank-label">
            <span>{tank.name}</span>
            <span className="burn-order">耗油顺序 {i + 1}</span>
          </div>
          <div className="tank-inputs">
            <input
              type="range"
              min={0}
              max={tank.capacity}
              step={10}
              value={fuel[tank.id] ?? 0}
              onChange={(e) => onFuel(tank.id, Number(e.target.value))}
              aria-label={`${tank.name}载油量`}
            />
            <input
              type="number"
              min={0}
              max={tank.capacity}
              step={10}
              value={fuel[tank.id] ?? 0}
              onChange={(e) => onFuel(tank.id, Number(e.target.value))}
              aria-label={`${tank.name}载油量数值`}
            />
            <span className="cap">/ {fmt(tank.capacity)} lb</span>
          </div>
          <div className="tank-arm">力臂 {tank.arm} in</div>
        </div>
      ))}
      <div className="tank-row burn-row">
        <div className="tank-label">
          <span>预计航程耗油</span>
        </div>
        <div className="tank-inputs">
          <input
            type="range"
            min={0}
            max={totalCapacity}
            step={10}
            value={burn}
            onChange={(e) => onBurn(Number(e.target.value))}
            aria-label="预计航程耗油"
          />
          <input
            type="number"
            min={0}
            max={totalCapacity}
            step={10}
            value={burn}
            onChange={(e) => onBurn(Number(e.target.value))}
            aria-label="预计航程耗油数值"
          />
          <span className="cap">lb</span>
        </div>
      </div>
      <dl className="fuel-facts">
        <div>
          <dt>机载燃油</dt>
          <dd>{fmt(computed.totalFuel)} lb</dd>
        </div>
        <div>
          <dt>耗油分配</dt>
          <dd>
            {computed.burnSequence.length > 0
              ? computed.burnSequence.map((s) => `${s.tank.name} ${fmt(s.amount)}`).join(' → ')
              : '—'}
          </dd>
        </div>
        <div>
          <dt>落地剩油</dt>
          <dd>{fmt(computed.totalFuel - computed.burnedTotal)} lb</dd>
        </div>
      </dl>
    </section>
  )
}
