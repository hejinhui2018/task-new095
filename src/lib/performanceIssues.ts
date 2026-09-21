import type { Issue } from './limits'
import { STAGE_LABELS, type PerformanceReport } from './performance'

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')

/**
 * 把跑道性能评估结果转换为统一的限制告警 Issue，
 * 与配载类问题一起在「限制检查」面板按优先级展示（跑道性能优先级仅次于结构重量）。
 */
export function performanceIssues(
  report: PerformanceReport,
  takeoffWeight: number,
  landingWeight: number,
): Issue[] {
  const issues: Issue[] = []

  // 每个被拒绝的阶段一条 error
  for (const r of report.rejections) {
    issues.push({
      id: `perf-${r.stage}-${r.code}`,
      severity: 'error',
      category: 'performance',
      message: `${STAGE_LABELS[r.stage]}限重无法确定：${r.message}`,
      contributors: [],
    })
  }

  if (report.controllingTakeoff && takeoffWeight > report.controllingTakeoff.effectiveLimitLb) {
    issues.push({
      id: 'perf-tow-overweight',
      severity: 'error',
      category: 'performance',
      message:
        `起飞重量 ${fmt(takeoffWeight)} lb 超过跑道性能控制限重 ` +
        `${fmt(report.controllingTakeoff.effectiveLimitLb)} lb（超出 ${fmt(takeoffWeight - report.controllingTakeoff.effectiveLimitLb)} lb）`,
      contributors: [],
    })
  }
  if (report.controllingLanding && landingWeight > report.controllingLanding.effectiveLimitLb) {
    issues.push({
      id: 'perf-ldw-overweight',
      severity: 'error',
      category: 'performance',
      message:
        `落地重量 ${fmt(landingWeight)} lb 超过着陆性能限重 ` +
        `${fmt(report.controllingLanding.effectiveLimitLb)} lb（超出 ${fmt(landingWeight - report.controllingLanding.effectiveLimitLb)} lb）`,
      contributors: [],
    })
  }

  return issues
}
