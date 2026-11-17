import { ComponentFixture, TestBed } from '@angular/core/testing'
import { NO_ERRORS_SCHEMA } from '@angular/core'
import { FracFinding, FracReport } from '../../models/frac-studio.models'
import { ReviewReportComponent } from './review-report.component'

const finding = (over: Partial<FracFinding>): FracFinding =>
  ({ check: 'structure', sev: 'm', title: 't', detail: '', refs: [], fix: '', source: 'computed', ...over } as FracFinding)

const report = (findings: FracFinding[]): FracReport => ({
  title: 'ANM', cadre: 'ANM', state: 'Bihar', at: '2026-11-16T10:00:00.000Z',
  stats: { roles: 1, activities: 1, competencies: 1, indicators: 0, B: 0, F: 0, D: 1, other: 0 },
  verdict: 'Revise', triage: 'revise', summary: '', checks: [], findings, strengths: [],
} as FracReport)

describe('ReviewReportComponent', () => {
  let fixture: ComponentFixture<ReviewReportComponent>
  let component: ReviewReportComponent

  beforeEach(() => {
    TestBed.configureTestingModule({ declarations: [ReviewReportComponent], schemas: [NO_ERRORS_SCHEMA] })
    fixture = TestBed.createComponent(ReviewReportComponent)
    component = fixture.componentInstance
    component.fixableCodes = new Set(['ANM1'])
    component.canFix = true
  })

  it('offers one Fix on every open finding, and none on fixed ones', () => {
    component.report = report([
      finding({ title: 'Outdated reference: TT / tetanus toxoid', check: 'context', refs: ['A1'] }),
      finding({ title: 'Core areas missing', check: 'coverage', refs: ['A2'] }),
      finding({ title: 'Done', fixed: true }),
    ])
    fixture.detectChanges()
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.fix-btn') as NodeListOf<HTMLElement>)
    expect(buttons.map(b => b.textContent?.trim())).toEqual(['Fix', 'Fix'])
    expect(fixture.nativeElement.textContent).not.toContain('no AI')
    expect(component.openFindings).toHaveLength(2)
  })

  it('shows no Fix buttons in the Reviewer (no fixable codes)', () => {
    component.fixableCodes = null
    component.report = report([finding({})])
    fixture.detectChanges()
    expect(fixture.nativeElement.querySelectorAll('.fix-btn')).toHaveLength(0)
    expect(component.openFindings).toHaveLength(0)
  })

  it('emits fixFinding and fixAll', () => {
    const one = finding({ title: 'One' })
    component.report = report([one])
    const picked: FracFinding[] = []
    let all = 0
    component.fixFinding.subscribe(f => picked.push(f))
    component.fixAll.subscribe(() => all++)
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.fix-btn') as HTMLButtonElement).click();
    (fixture.nativeElement.querySelector('.fix-all-btn') as HTMLButtonElement).click()
    expect(picked).toEqual([one])
    expect(all).toBe(1)
  })

  it('estimates the cost with the re-check, and describes the last fix', () => {
    component.report = report([finding({ check: 'bloom', refs: ['ANM1'] }), finding({ check: 'coverage', refs: ['A1'] })])
    // one ladder (0.011) + one content call (0.04) + the re-check (0.08)
    expect(component.fixAllCost).toBe('about $0.13')
    const fix = { at: '2026-11-16T11:00:00.000Z', total: 2, fixed: 1, skipped: [], changes: { activities: 3, competencies: 1, added: 2, ladders: 1 } }
    component.lastFix = fix
    expect(component.lastFixShown).toBe(fix)
    expect(component.changesLine(fix)).toBe('3 activities rewritten · 1 competency changed · 2 added · 1 ladder rewritten')
    component.lastFix = { ...fix, at: '2026-11-16T09:00:00.000Z' }
    expect(component.lastFixShown).toBeNull()
  })
})
