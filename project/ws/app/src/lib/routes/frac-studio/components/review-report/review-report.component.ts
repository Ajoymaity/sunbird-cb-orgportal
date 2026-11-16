import { Component, EventEmitter, Input, Output } from '@angular/core'
import {
  FRAC_STUDIO_FIX_CONTENT_USD, FRAC_STUDIO_LADDER_FIX_USD, FRAC_STUDIO_RECHECK_USD, FRAC_STUDIO_SEVERITY_LABELS,
  FRAC_STUDIO_TRIAGE_LABELS,
} from '../../constants/frac-studio.constants'
import { FracFinding, FracLastFix, FracReport } from '../../models/frac-studio.models'
import { normalizeCode } from '../../utils/frac-studio-refs.util'

/** An "Outdated reference: …" finding from the check's outdated-name list. */
const isOutdated = (finding: FracFinding) => finding.title.startsWith('Outdated reference:')

/** Graded review report (spec 6.5). Shared by the Reviewer and the Creator's expert check. */
@Component({
  selector: 'ws-app-frac-review-report',
  templateUrl: './review-report.component.html',
  styleUrls: ['./review-report.component.scss'],
  standalone: false,
})
export class ReviewReportComponent {
  @Input() report: FracReport | null = null
  /** Normalised competency codes that can be fixed from here (the Creator); null in the Reviewer. */
  @Input() fixableCodes: Set<string> | null = null
  @Input() canFix = false
  /** The FRAC's last "Fix all findings" summary (the Creator); shown while it is newer than this report. */
  @Input() lastFix: FracLastFix | null = null
  /** "Fix" on one finding: the service fixes just that finding with the agent. */
  @Output() readonly fixFinding = new EventEmitter<FracFinding>()
  /** "Fix all findings": the service fixes every open finding with the agent in one job. */
  @Output() readonly fixAll = new EventEmitter<void>()

  readonly severityLabels = FRAC_STUDIO_SEVERITY_LABELS

  get triageLabel(): string {
    return this.report ? FRAC_STUDIO_TRIAGE_LABELS[this.report.triage] : ''
  }

  /** Stats row shown under the summary. */
  get statItems(): { label: string, value: number }[] {
    const s = this.report?.stats
    if (!s) {
      return []
    }
    return [
      { label: 'Roles', value: s.roles },
      { label: 'Activities', value: s.activities },
      { label: 'Competencies', value: s.competencies },
      { label: 'Indicators', value: s.indicators },
      { label: 'Domain', value: s.D },
      { label: 'Functional', value: s.F },
      { label: 'Behavioural', value: s.B },
      ...(s.kcm ? [{ label: 'KCM format', value: s.kcm }] : []),
    ]
  }

  /** Where the findings came from (rules r3 §8): rule-based ones repeat exactly, AI ones carry a quote. */
  get provenance(): string {
    const findings = this.report?.findings ?? []
    const ruleBased = findings.filter(f => f.source === 'computed').length
    const ai = findings.length - ruleBased
    return `${ruleBased} rule-based ${ruleBased === 1 ? 'finding' : 'findings'} (the same on every run) · `
      + `${ai} AI ${ai === 1 ? 'judgement' : 'judgements'}, each backed by a quote`
  }

  /**
   * Findings the service fixes by rewriting ladders (Bloom's verbs, ladder shape, scope in a level, outdated names in a
   * level) for the competencies they name. Used only for the cost estimate: every finding is fixed by the agent.
   */
  private aboutLadders(finding: FracFinding): boolean {
    const codes = this.fixableCodes
    const kind = finding.check === 'bloom' || finding.check === 'ladder' || isOutdated(finding)
      || (finding.check === 'context' && !finding.title.startsWith('Does not reflect'))
    return !!codes && !finding.fixed && kind && finding.refs.some(ref => codes.has(normalizeCode(ref)))
  }

  /** Every open finding, in the Creator only (the Reviewer has nothing to fix). */
  get openFindings(): FracFinding[] {
    return this.fixableCodes ? (this.report?.findings ?? []).filter(f => !f.fixed) : []
  }

  /**
   * "about $0.10": ladders for the competencies ladder findings name, plus one agent call when any finding is about
   * content (activities, coverage, structure, state fit). New competencies add a little more for their ladders.
   */
  get fixAllCost(): string {
    const codes = this.fixableCodes
    if (!codes) {
      return ''
    }
    const ladders = this.openFindings.filter(f => this.aboutLadders(f))
    const named = new Set(ladders.flatMap(f => f.refs.map(normalizeCode).filter(code => codes.has(code))))
    // Anything that is not purely a ladder finding (outdated names included) goes through the one content call
    const content = this.openFindings.some(f => !this.aboutLadders(f) || isOutdated(f)) ? FRAC_STUDIO_FIX_CONTENT_USD : 0
    return `about $${(named.size * FRAC_STUDIO_LADDER_FIX_USD + content + FRAC_STUDIO_RECHECK_USD).toFixed(2)}`
  }

  /** The last fix's summary, saved after the check it re-ran; a later check (run on its own) hides it. */
  get lastFixShown(): FracLastFix | null {
    return this.lastFix && this.report && this.lastFix.at > this.report.at ? this.lastFix : null
  }

  foundBy(finding: FracFinding): string {
    return finding.source === 'computed' ? 'Rule-based check' : 'AI judgement · quoted from the file'
  }

  trackByIndex(index: number): number {
    return index
  }
}
