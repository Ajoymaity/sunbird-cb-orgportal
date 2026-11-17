import { Frac } from '../models/frac-studio.models'
import { curStep, fracProgress, staleSteps } from './frac-studio-progress.util'

const base = (over: Partial<Frac> = {}): Frac => ({
  id: 'f1', createdAt: '', updatedAt: '', ownerId: 'o', step: 1, cadre: 'ANM', cadreFull: 'ANM', state: 'Bihar',
  size: 'standard', prompt: '', codePrefix: 'ANM', postings: [], research: null, roles: [], competencies: [],
  rolesDirty: false, review: null, ...over,
} as Frac)

const research = { summary: 's', sourceNotes: '', sources: [], authorised: '', notAuthorised: '', stateContext: '', assumptions: '' }
const comp = (levels: Frac['competencies'][number]['levels'] = null) =>
  ({ code: 'ANM1', label: 'Care', description: '', type: 'Domain', area: '', kcm: '', levels })
const role = (comp = '') => ({ code: 'R1', title: 'Care', source: '', activities: [{ code: 'A1', text: 'Do', postings: {}, source: '', tier: '', comp }] })

describe('curStep (competencies before roles)', () => {
  it('goes research, competencies, roles, ladders, check', () => {
    expect(curStep(base())).toBe(0)
    expect(curStep(base({ research }))).toBe(1)
    expect(curStep(base({ research, competencies: [comp()] }))).toBe(2)
    expect(curStep(base({ research, competencies: [comp()], roles: [role('ANM1@L3')] }))).toBe(3)
    const levels = [1, 2, 3, 4, 5].map(n => ({ label: `L${n}`, desc: '' }))
    expect(curStep(base({ research, competencies: [comp(levels)], roles: [role('ANM1@L3')] }))).toBe(4)
  })

  it('sends activities changed after mapping back to the roles step', () => {
    expect(curStep(base({ research, competencies: [comp()], roles: [role('ANM1@L3')], rolesDirty: true }))).toBe(2)
  })

  it('shows Competencies as step 3 and Roles as step 4 in the tracker', () => {
    const steps = fracProgress(base({ research }))
    expect(steps.map(s => s.title)).toEqual(['Brief', 'Job research', 'Competencies', 'Roles & activities', 'Level ladders', 'Expert check & download'])
    expect(steps[2].state).toBe('current')
  })
})

describe('staleSteps', () => {
  it('marks the roles out of date when competencies changed after them', () => {
    const f = base({
      research, competencies: [comp()], roles: [role('ANM1@L3')],
      changedAt: { research: '2026-11-16T01:00:00Z', roles: '2026-11-16T02:00:00Z', competencies: '2026-11-16T03:00:00Z' },
    })
    expect(staleSteps(f)).toEqual(['roles'])
  })
})
