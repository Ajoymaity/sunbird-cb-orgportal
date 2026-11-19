import { Component, OnDestroy, OnInit } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { Observable, of, Subject, Subscription } from 'rxjs'
import { catchError, debounceTime, switchMap } from 'rxjs/operators'
import { FracUploadItem } from '../../components/document-upload/document-upload.component'
import {
  FRAC_STUDIO_AUTO_MAP_MS,
  FRAC_STUDIO_LADDER_FIX_USD,
  FRAC_STUDIO_RERUN_COST,
  FRAC_STUDIO_STATES,
} from '../../constants/frac-studio.constants'
import {
  Frac,
  FracCompetency,
  FracDocument,
  FracDocumentKind,
  FracQuickCheck,
  FracFinding,
  FracGenStep,
  FracJob,
  FracPosting,
  FracResearch,
  FracRole,
  FracSaveStatus,
  FracStep,
  FracStepBody,
} from '../../models/frac-studio.models'
import { FracStudioApiService } from '../../services/frac-studio-api.service'
import { FracStudioAutosaveService } from '../../services/frac-studio-autosave.service'
import { apiErrorMessage, runningJobId, saveBlob } from '../../utils/frac-studio-download.util'
import { emptyResearch } from '../../utils/frac-studio-edit.util'
import {
  changedBefore, copiedRoles, curStep, FRAC_STEP_TITLES, fracProgress, FracStepProgress, staleSteps,
} from '../../utils/frac-studio-progress.util'
import { dominantPrefix, normalizeCode, usedByMap } from '../../utils/frac-studio-refs.util'
import { reapplyWhat } from '../../utils/frac-studio-sheet.util'

export type CreatorTab = 'research' | 'roles' | 'competencies' | 'ladders' | 'check' | 'history'

/** Primary action per curStep (spec 5 labels): research, competencies, roles & activities, ladders, check, download. */
const PRIMARY: { label: string, step: FracGenStep | null }[] = [
  { label: 'Research the job', step: 'research' },
  { label: 'Derive competencies', step: 'competencies' },
  { label: 'Build roles & activities', step: 'roles' },
  { label: 'Write level ladders', step: 'ladders' },
  { label: 'Run expert check', step: null },
  { label: 'Download Excel', step: null },
]

/** Edits autosave in bursts: wait this long after the last save before re-running the quick checks. */
const QUICK_CHECK_DEBOUNCE_MS = 400

const GEN_STEPS: readonly FracGenStep[] = ['research', 'roles', 'competencies', 'ladders']

/** Steps whose tab has an upload: the primary button opens the tab before the agent runs, so a sheet can go in first. */
const UPLOAD_FIRST: readonly FracGenStep[] = ['research']

/** Shown beside the primary button on those tabs while nothing is uploaded there. */
const UPLOAD_FIRST_HINTS: Partial<Record<FracGenStep, string>> = {
  research: 'Have an existing FRAC, a job description, sources sheet or competency sheet? Upload it above. '
    + 'Otherwise the agent researches the job.',
}

/** A tab with a feedback box: each AI step's tab, and the Expert check (its Fix buttons follow it). */
type FeedbackTab = FracGenStep | 'check'

/** Shown under the box before the step has run: the text steers the first run. */
const GUIDE_HINTS: Record<FeedbackTab, string> = {
  research: 'Optional. Read first, before anything else, e.g. "Only competencies ASHA1–ASHA5 and only the roles from the dictionary". '
    + 'The agent can pick competencies and roles from the uploaded documents and map them.',
  competencies: 'Optional. Read first, e.g. "Use only ASHA1–ASHA5 from the sheet" or "Include a digital literacy competency". '
    + 'The agent can pick competencies from the uploaded documents.',
  roles: 'Optional. Read first, e.g. "Take only the roles from the dictionary" or "Keep activities to one line". '
    + 'The agent can pick roles from the uploaded documents and map them.',
  ladders: 'Optional. Read first, e.g. "Level 5 includes mentoring".',
  check: 'Optional. Fix and Fix all follow these instructions, e.g. "Keep activity wording short". The check itself does not see them.',
}

/** What a revise keeps and what it redoes, shown under each feedback box. */
const REVISE_HINTS: Record<FracGenStep, string> = {
  research: 'Your feedback is read first. It can pick competencies and roles from the uploaded documents and map them; '
    + 'research is redone only for what is left, e.g. "Add the state\'s 104 helpline".',
  roles: 'Your feedback is read first: it can take roles from the uploaded documents and map them. Otherwise roles and activities '
    + 'are redone with it, every activity is mapped again, and activities your team added are kept.',
  competencies: 'Your feedback is read first: it can pick competencies from the uploaded documents. Otherwise competencies and mappings '
    + 'are redone with it; ladders are kept where a competency\'s code and label stay the same.',
  ladders: 'Feedback applies to "Rewrite all" and to "Revise" on a single competency.',
}

/** What an attached standard sheet changes, shown under its upload slot. */
const IN_USE: Record<FracDocumentKind, string> = {
  brief: '',
  dictionary: 'FRAC Studio keeps this FRAC: its roles, mappings and ladders. Steps only fill what is missing; '
    + 'research, the expert check and Fix all update it.',
  roles: 'The Roles step keeps these roles and only writes activities for roles that have none.',
  competencies: 'The roles step maps each activity to these competencies; ladders in the sheet are kept, so only missing ones are written.',
  sources: 'Research uses these sources and does not search the web.',
}

/** The counts a document's import summary carries, as one line. */
function documentDetail(doc: FracDocument): string {
  const counts = doc.parsed?.counts ?? {}
  if (doc.kind === 'brief') {
    return `${doc.chars.toLocaleString('en-IN')} characters of text`
  }
  return Object.entries(counts).map(([key, n]) => `${n} ${key}`).join(' · ')
}

/** One FRAC in the Creator: progress tracker, AI steps with revise, editors with autosave, expert check, history. */
@Component({
  selector: 'ws-app-frac-studio-creator-detail',
  templateUrl: './creator-detail.component.html',
  styleUrls: ['./creator-detail.component.scss'],
  standalone: false,
  providers: [FracStudioAutosaveService],
})
export class CreatorDetailComponent implements OnInit, OnDestroy {
  readonly tabs: { key: CreatorTab, label: string }[] = [
    { key: 'research', label: 'Research' },
    { key: 'competencies', label: 'Competencies' },
    { key: 'roles', label: 'Roles & activities' },
    { key: 'ladders', label: 'Level ladders' },
    { key: 'check', label: 'Expert check' },
    { key: 'history', label: 'History' },
  ]
  readonly reviseHints = REVISE_HINTS
  readonly guideHints = GUIDE_HINTS

  frac: Frac | null = null
  steps: FracStepProgress[] = []
  /** Steps an earlier change left out of date (roles is covered by the rolesDirty banner while that is set). */
  stale: Exclude<FracStep, 'brief'>[] = []
  readonly stepTitles = FRAC_STEP_TITLES
  /** Pending automatic "Map activities to competencies" after activity edits, and whether this round already tried. */
  private autoMapTimer?: ReturnType<typeof setTimeout>
  private autoMapTried = false
  readonly states = FRAC_STUDIO_STATES
  /** The brief card's edit form while it is open. */
  briefDraft: { cadre: string, state: string, prompt: string } | null = null
  /** "Clear copied roles" waiting for its inline confirmation. */
  confirmClearRoles = false
  usedBy = new Map<string, string[]>()
  /** Normalised competency codes, so findings can offer "Fix these competencies". */
  competencyCodes = new Set<string>()
  tab: CreatorTab = 'roles'
  /** The running or last AI step / expert check. */
  job: FracJob | null = null
  /** A step was requested and its job id has not come back yet. */
  starting = false
  saveStatus: FracSaveStatus = 'idle'
  historyKey = 0
  /** The Roles box text sent with a mapping run, cleared from that box when the run finishes. */
  private mappingSentRoles = false

  /** Text typed in each tab's feedback box: instructions for the next run, or feedback for Revise. */
  feedback: Record<FeedbackTab, string> = { research: '', roles: '', competencies: '', ladders: '', check: '' }
  loading = true
  error = ''
  /** Documents attached to this FRAC: brief documents for research, and the standard sheets in use. */
  documents: FracDocument[] = []
  /** The kind being uploaded, so only that slot shows "Uploading…". */
  uploading: FracDocumentKind | null = null
  /** Quick checks (Bloom's verbs, FRAC structure) on the FRAC as saved, refreshed after every load, save, upload and step. */
  quickChecks: FracQuickCheck[] = []
  private readonly quickRefresh = new Subject<void>()
  readonly inUse = IN_USE
  /** The roles preview popup renders only while open. */
  previewOpen = false

  private fracId = ''
  private readonly subs = new Subscription()

  constructor(
    private readonly api: FracStudioApiService,
    private readonly autosave: FracStudioAutosaveService,
    private readonly route: ActivatedRoute,
  ) { }

  ngOnInit(): void {
    this.subs.add(this.autosave.status$.subscribe(status => this.saveStatus = status))
    this.subs.add(this.autosave.saved$.subscribe(saved => this.onSaved(saved)))
    // A failed refresh keeps the last list; the expert check still runs every rule
    this.subs.add(
      this.quickRefresh.pipe(
        debounceTime(QUICK_CHECK_DEBOUNCE_MS),
        switchMap(() => this.api.ruleChecks(this.fracId).pipe(catchError(() => of(null)))),
      ).subscribe(checks => {
        if (checks) {
          this.quickChecks = checks
        }
      }),
    )
    this.subs.add(
      this.route.paramMap.subscribe(params => {
        this.fracId = params.get('id') || ''
        this.autosave.attach(this.fracId)
        this.load(true)
      }),
    )
  }

  ngOnDestroy(): void {
    clearTimeout(this.autoMapTimer)
    this.subs.unsubscribe()
  }

  get prefix(): string {
    return this.frac ? (this.frac.codePrefix || dominantPrefix(this.frac.competencies.map(c => c.code)) || 'C') : 'C'
  }

  get primary(): { label: string, step: FracGenStep | null } {
    if (!this.frac) {
      return PRIMARY[0]
    }
    const step = curStep(this.frac, this.briefDocCount)
    const action = PRIMARY[step]
    if (step === 4 && this.frac.review) {
      return { ...action, label: 'Re-run expert check' }
    }
    // Activities changed after mapping: map them again (the competencies step maps only while they are current)
    if (step === 2 && this.frac.rolesDirty && this.frac.roles.some(r => r.activities.length)) {
      return { label: 'Map activities to competencies', step: 'competencies' }
    }
    // Roles from a sheet or a matched position are kept: only empty roles get activities
    if (step === 2 && this.frac.roles.length) {
      return { ...action, label: 'Write missing activities' }
    }
    return action
  }

  /**
   * On Level ladders and Expert check the footer shows both the download and the expert check (the only place they
   * appear, no duplicates in the tab): the download is the extra while the check is next, the check after it.
   */
  get footerExtra(): 'check' | 'download' | null {
    if (!this.frac || (this.tab !== 'ladders' && this.tab !== 'check')) {
      return null
    }
    const step = curStep(this.frac, this.briefDocCount)
    return step === 4 ? 'download' : step === 5 ? 'check' : null
  }

  /** On the next step's own tab, while nothing is uploaded there: the upload comes first, else the button runs the agent. */
  get uploadFirstHint(): string {
    const step = this.primary.step
    if (!this.frac || this.running || !step || step !== this.tab || !UPLOAD_FIRST.includes(step)) {
      return ''
    }
    const kinds: FracDocumentKind[] = step === 'research' ? ['brief', 'dictionary', 'sources', 'competencies'] : [step as FracDocumentKind]
    return kinds.some(kind => this.docItems(kind).length) ? '' : UPLOAD_FIRST_HINTS[step] ?? ''
  }

  /** Everything but "Download Excel" changes the FRAC. */
  get primaryMutates(): boolean {
    return !!this.frac && curStep(this.frac, this.briefDocCount) < 5
  }

  get running(): boolean {
    return this.starting || (!!this.job && (this.job.status === 'queued' || this.job.status === 'running'))
  }

  /** Steps and the check read the saved FRAC, so wait until edits are saved. */
  get canRun(): boolean {
    return !!this.frac && !this.running && (this.saveStatus === 'idle' || this.saveStatus === 'saved')
  }

  get canCheck(): boolean {
    return this.canRun && !!this.frac && this.frac.competencies.length > 0
  }

  /** The Excel can be downloaded at any point with competencies, so the team can check it before the expert check. */
  get canDownload(): boolean {
    return !!this.frac && this.frac.competencies.length > 0 && !this.running
  }

  /** A download before the expert check, or after edits that put the check out of date, is a draft. */
  get downloadIsDraft(): boolean {
    return !this.frac?.review || !!this.frac.reviewStale
  }

  /** The AI step behind the open tab, once it has output to revise (ladders: once competencies exist). */
  /** The open tab's feedback box: every AI step's tab, and the Expert check once it has findings to fix. */
  get feedbackTab(): FeedbackTab | null {
    if (GEN_STEPS.includes(this.tab as FracGenStep)) {
      return this.tab as FracGenStep
    }
    return this.tab === 'check' && this.frac?.review ? 'check' : null
  }

  get reviseStep(): FracGenStep | null {
    const f = this.frac
    if (!f || !GEN_STEPS.includes(this.tab as FracGenStep)) {
      return null
    }
    const has: Record<FracGenStep, boolean> = {
      research: !!f.research,
      roles: f.roles.length > 0,
      competencies: f.competencies.length > 0,
      ladders: f.competencies.length > 0,
    }
    return has[this.tab as FracGenStep] ? this.tab as FracGenStep : null
  }

  get missingLadders(): number {
    return this.frac ? this.frac.competencies.filter(c => c.levels === null).length : 0
  }

  /** "Preview roles" needs the mapping: competencies exist and every activity is mapped to one. */
  get canPreview(): boolean {
    const activities = this.frac?.roles.flatMap(r => r.activities) ?? []
    return !!this.frac?.competencies.length && activities.length > 0 && activities.every(a => !!a.comp.trim())
  }

  openPreview(dialog: HTMLDialogElement): void {
    this.previewOpen = true
    dialog.showModal()
  }

  /** Brief documents can be added at any time; after research, a change asks for research to be checked again. */
  get briefDocumentsOpen(): boolean {
    return !!this.frac
  }

  /** Opens the brief card's edit form with the current position, state and instructions. */
  editBrief(): void {
    if (this.frac) {
      this.briefDraft = { cadre: this.frac.cadreFull || this.frac.cadre, state: this.frac.state, prompt: this.frac.prompt }
    }
  }

  get canSaveBrief(): boolean {
    return !!this.briefDraft && !!this.briefDraft.cadre.trim() && !!this.briefDraft.state
  }

  /** Saves the brief. The position the team types replaces the research title too, so the card shows it. */
  saveBrief(): void {
    if (!this.frac || !this.briefDraft || !this.canSaveBrief) {
      return
    }
    const cadre = this.briefDraft.cadre.trim()
    const { state, prompt } = this.briefDraft
    const changed = cadre !== (this.frac.cadreFull || this.frac.cadre) || state !== this.frac.state || prompt !== this.frac.prompt
    this.briefDraft = null
    if (!changed) {
      return
    }
    this.applyLocal({ cadre, cadreFull: cadre, state, prompt, ...this.staleCheck() })
    this.autosave.queue('cadre', cadre)
    this.autosave.queue('cadreFull', cadre)
    this.autosave.queue('state', state)
    this.autosave.queue('prompt', prompt)
  }

  /** Job descriptions attached: with one, roles copied from a matched position are rebuilt by the roles step. */
  get briefDocCount(): number {
    return this.documents.filter(d => d.kind === 'brief').length
  }

  /** Roles still as copied from a matched position, for the Roles tab notice. */
  get hasCopiedRoles(): boolean {
    return !!this.frac && copiedRoles(this.frac)
  }

  /** Removes the copied roles, so the roles step builds them from the research; the copied postings stay. */
  clearCopiedRoles(): void {
    if (!this.frac?.seededFrom || !this.canRun) {
      return
    }
    this.confirmClearRoles = false
    this.applyLocal({ roles: [], seededFrom: { ...this.frac.seededFrom, withRoles: false } })
    this.autosave.queueClearCopiedRoles()
  }

  /** The upload slot's rows for one kind of document. */
  docItems(kind: FracDocumentKind): FracUploadItem[] {
    return this.documents.filter(d => d.kind === kind)
      .map(d => ({ key: d.id, name: d.filename, detail: documentDetail(d), warnings: d.parsed?.warnings ?? [], checks: d.parsed?.checks }))
  }

  /**
   * Attaches a document or imports a standard sheet. Waits for saved edits (canRun), because a sheet replaces
   * that part of the FRAC; the service snapshots the FRAC first, so History can undo it.
   */
  uploadDocument(kind: FracDocumentKind, file: File): void {
    if (!this.canRun) {
      return
    }
    this.error = ''
    this.uploading = kind
    this.subs.add(
      this.api.uploadDocument(this.fracId, kind, file).subscribe({
        next: ({ document, frac }) => {
          this.uploading = null
          // A new sheet replaces the older one of its kind (a dictionary included); brief documents add up
          this.documents = [...this.documents.filter(d => kind === 'brief' || d.kind !== kind), document]
          this.historyKey++
          this.setFrac(frac)
          this.quickRefresh.next()
        },
        error: err => {
          this.uploading = null
          this.error = apiErrorMessage(err, 'The file could not be uploaded.')
        },
      }),
    )
  }

  /** This tab's quick checks. */
  quickChecksFor(tab: FracQuickCheck['tab']): FracQuickCheck[] {
    return this.quickChecks.filter(c => c.tab === tab)
  }

  /** Some role has activities, so the Roles tab shows its quick checks. */
  get hasActivities(): boolean {
    return !!this.frac && this.frac.roles.some(r => r.activities.length > 0)
  }

  /** Some competency has a ladder, so the Level ladders tab shows its quick checks. */
  get hasLadders(): boolean {
    return !!this.frac && this.frac.competencies.some(c => !!c.levels?.length)
  }

  /** The expert check is the next thing to run, or to re-run, from here. */
  get expertCheckNext(): boolean {
    return !!this.frac && (curStep(this.frac, this.briefDocCount) === 4 || this.footerExtra === 'check')
  }

  /** What re-applying this kind of sheet puts back when its content was changed after the upload; '' hides the control. */
  /** Asked before a FRAC dictionary upload replaces content already on the FRAC; '' on an empty FRAC. */
  /**
   * Under the dictionary slot: what it does while the FRAC was last built from it. After a later Roles or Competencies
   * sheet it stays listed (feedback can still pick from it) without the note.
   */
  get dictionaryInUse(): string {
    const name = this.docItems('dictionary')[0]?.name
    return name && this.frac?.uploads?.dictionary === name ? IN_USE.dictionary : ''
  }

  reapplyWhatFor(kind: FracDocumentKind): string {
    return this.frac ? reapplyWhat(this.frac, this.documents.find(d => d.kind === kind)) : ''
  }

  /** Puts the uploaded sheet's rows back over the team's edits; the service saves a version first. */
  reapplyDocument(kind: FracDocumentKind, documentId: string): void {
    if (!this.canRun) {
      return
    }
    this.error = ''
    this.uploading = kind
    this.subs.add(
      this.api.reapplyDocument(this.fracId, documentId).subscribe({
        next: frac => {
          this.uploading = null
          this.historyKey++
          this.setFrac(frac)
          this.quickRefresh.next()
        },
        error: err => {
          this.uploading = null
          this.error = apiErrorMessage(err, 'The sheet could not be re-applied.')
        },
      }),
    )
  }

  /** Removes a document; a sheet's content stays in the FRAC, and its step goes back to the AI. */
  removeDocument(documentId: string): void {
    if (!this.canRun) {
      return
    }
    this.subs.add(
      this.api.removeDocument(this.fracId, documentId).subscribe({
        next: frac => {
          this.documents = this.documents.filter(d => d.id !== documentId)
          this.setFrac(frac)
          this.quickRefresh.next()
        },
        error: err => this.error = apiErrorMessage(err, 'The document could not be removed.'),
      }),
    )
  }

  downloadTemplate(kind: FracDocumentKind): void {
    this.subs.add(
      this.api.downloadTemplate(kind).subscribe({
        next: file => saveBlob(file.blob, file.filename),
        error: err => this.error = apiErrorMessage(err, 'The template could not be downloaded.'),
      }),
    )
  }

  onPrimary(): void {
    const action = this.primary
    if (action.step && UPLOAD_FIRST.includes(action.step) && this.tab !== action.step) {
      // First the step's own tab, where its document or sheet can be uploaded (and research filled in by hand);
      // from there the same button runs the agent
      this.tab = action.step
    } else if (action.step === 'competencies' && this.frac && curStep(this.frac, this.briefDocCount) === 2) {
      // "Map activities to competencies" after activity edits: map again from the Roles tab
      this.mapActivities()
    } else if (action.step) {
      this.runStep(action.step)
    } else if (this.frac && curStep(this.frac, this.briefDocCount) === 4) {
      this.checkNow()
    } else {
      this.download()
    }
  }

  /** AI research (spec 5.2). The brief stays editable; a later change marks research as needing a look. */
  researchWithAi(): void {
    this.runStep('research')
  }

  /** Saves empty research to fill in by hand. */
  startResearch(): void {
    const research = emptyResearch()
    this.applyLocal({ research })
    this.autosave.queue('research', research)
  }

  /** Re-runs the step with the team's feedback (spec 5, revise). */
  revise(step: FracGenStep): void {
    const feedback = this.feedback[step].trim()
    if (feedback) {
      this.runStep(step, { feedback })
    }
  }

  /** Ladders for competencies that have none yet. */
  writeMissingLadders(): void {
    this.runStep('ladders')
  }

  rewriteAllLadders(): void {
    if (this.frac) {
      this.runStep('ladders', this.withFeedback('ladders', { codes: this.frac.competencies.map(c => c.code) }))
    }
  }

  reviseLadder(code: string): void {
    this.runStep('ladders', this.withFeedback('ladders', { codes: [code] }))
  }

  /**
   * "Fix" on one finding: the same job as Fix all, limited to this finding (the agent edits activities
   * and competencies, and rewrites the ladders it names). A version is saved first; the check then shows out of date.
   */
  fixFinding(finding: FracFinding): void {
    if (this.canRun) {
      this.startJob(this.api.fixAll(this.fracId, [finding.title], this.feedback.check.trim() || undefined), 'The fix could not be started.')
    }
  }

  /** Steps an upload or edit left out of date, in the order the flow builds them (each from the one before). */
  get staleGenSteps(): FracGenStep[] {
    if (!this.frac) {
      return []
    }
    const stale = new Set<string>(this.stale)
    const rolesDirty = this.frac.rolesDirty
    return (['research', 'competencies', 'roles', 'ladders'] as const)
      .filter(step => stale.has(step) || (step === 'roles' && rolesDirty))
  }

  /**
   * While anything is out of date, the footer offers to re-run the open tab's own step (the tab being updated), as
   * the first build did on each tab. Only once that step has output, and not when the main button already offers it.
   */
  get rerunStep(): FracGenStep | null {
    const step = this.reviseStep
    return this.staleGenSteps.length && step && step !== this.primary.step ? step : null
  }

  /** On a tab without a step of its own (Expert check, History): the earliest out-of-date step's tab, opened first (no AI). */
  get staleNext(): FracGenStep | null {
    const next = this.staleGenSteps[0] ?? null
    return next && !GEN_STEPS.includes(this.tab as FracGenStep) && next !== this.primary.step ? next : null
  }

  /** "Re-run research (about $0.05–0.20)": what the footer's re-run button redoes, and roughly what it costs. */
  get rerunLabel(): string {
    const step = this.rerunStep
    if (!step || !this.frac) {
      return ''
    }
    const sheet = !!this.frac.uploads?.competencies
    const labels: Record<FracGenStep, string> = {
      research: `Re-run research (about ${FRAC_STUDIO_RERUN_COST.research})`,
      roles: this.rolesNeedMapping
        ? `Map activities to competencies (about ${FRAC_STUDIO_RERUN_COST.map})`
        : `Rebuild roles & activities (about ${FRAC_STUDIO_RERUN_COST.roles})`,
      competencies: sheet
        ? `Map activities to your competencies (about ${FRAC_STUDIO_RERUN_COST.map})`
        : `Re-derive competencies (about ${FRAC_STUDIO_RERUN_COST.derive})`,
      ladders: `Rewrite level ladders (about $${Math.max(0.01, this.frac.competencies.length * FRAC_STUDIO_LADDER_FIX_USD).toFixed(2)})`,
    }
    return labels[step]
  }

  /**
   * The roles are out of date only because the competencies changed after them, or activities were edited after
   * mapping: mapping them again is enough, no rebuild.
   */
  get rolesNeedMapping(): boolean {
    return !!this.frac && (this.frac.rolesDirty || changedBefore(this.frac, 'roles') === 'competencies')
  }

  /**
   * Maps every activity to the competencies again (the competencies step maps only while they are current). Runs by
   * itself after activity edits (scheduleAutoMap); the footer can still offer it. `auto` leaves the open tab alone.
   */
  mapActivities(auto = false): void {
    if (this.canRun) {
      if (!auto) {
        this.tab = 'roles'
      }
      // Clicked from the Roles tab: the text in its box goes along as the team's instructions (not on the automatic run)
      const guidance = auto ? '' : this.feedback.roles.trim()
      this.mappingSentRoles = !!guidance
      this.startJob(this.api.runStep(this.fracId, 'competencies', guidance ? { guidance } : {}), 'The mapping could not be started.')
    }
  }

  /**
   * Activities changed after mapping (rolesDirty): map them again automatically once the edits are saved and the team
   * has paused for FRAC_STUDIO_AUTO_MAP_MS, instead of waiting for a button. One try per round of edits, so a failed
   * run does not repeat; nothing runs while a step is running or edits are unsaved.
   */
  private scheduleAutoMap(): void {
    clearTimeout(this.autoMapTimer)
    const f = this.frac
    if (!f?.rolesDirty) {
      this.autoMapTried = false
      return
    }
    if (this.autoMapTried || !f.competencies.length || !f.roles.some(r => r.activities.length)) {
      return
    }
    this.autoMapTimer = setTimeout(() => {
      if (this.frac?.rolesDirty && this.canRun && !this.autosave.hasUnsaved && !this.autoMapTried) {
        this.autoMapTried = true
        this.mapActivities(true)
      } else if (this.frac?.rolesDirty && !this.autoMapTried) {
        this.scheduleAutoMap()
      }
    }, FRAC_STUDIO_AUTO_MAP_MS)
  }

  /** Re-runs the step the footer offers, the same run as that tab's own button. */
  rerun(step: FracGenStep): void {
    if (step === 'roles' && this.rolesNeedMapping) {
      this.mapActivities()
    } else if (step === 'ladders') {
      this.rewriteAllLadders()
    } else {
      this.runStep(step)
    }
  }

  /**
   * "Fix all findings" on the expert check: the service fixes every open finding in one job (outdated names, content
   * edits by the agent, then ladders) after saving a version. The page follows the job, reloads the FRAC, and the
   * check shows out of date so the team re-runs it.
   */
  fixAllFindings(): void {
    if (this.canRun) {
      this.startJob(this.api.fixAll(this.fracId, undefined, this.feedback.check.trim() || undefined), 'Fix all findings could not be started.')
    }
  }

  onResearchChange(research: FracResearch): void {
    this.applyLocal({ research, ...this.staleCheck() })
    this.autosave.queue('research', research)
  }

  /** Postings changes; removing a posting also clears its column from the activities. */
  onPostingsChange(change: { postings: FracPosting[], roles?: FracRole[] }): void {
    this.applyLocal({ postings: change.postings, ...(change.roles ? { roles: change.roles } : {}), ...this.staleCheck() })
    this.autosave.queue('postings', change.postings)
    if (change.roles) {
      this.autosave.queue('roles', change.roles)
    }
  }

  onRolesChange(roles: FracRole[]): void {
    this.applyLocal({ roles, ...this.staleCheck() })
    this.autosave.queue('roles', roles)
  }

  onCompetenciesChange(competencies: FracCompetency[]): void {
    this.applyLocal({ competencies, ...this.staleCheck() })
    this.autosave.queue('competencies', competencies)
  }

  /** The team checked a step after an earlier one changed, so it no longer needs attention. */
  markStepChecked(step: FracStep): void {
    if (!this.frac) {
      return
    }
    this.applyLocal({
      changedAt: { ...this.frac.changedAt, [step]: new Date().toISOString() },
      ...(step === 'roles' ? { rolesDirty: false } : {}),
    })
    this.autosave.queueChecked(step)
  }

  retrySave(): void {
    this.autosave.retry()
  }

  onRestored(frac: Frac): void {
    this.setFrac(frac)
    this.quickRefresh.next()
  }

  /** Expert check (spec 5.6): the review engine on the saved FRAC, then reload. */
  /** Opens the Expert check tab, where the findings appear, and starts the check. */
  checkNow(): void {
    this.tab = 'check'
    this.runCheck()
  }

  runCheck(): void {
    if (this.canCheck) {
      this.startJob(this.api.startCheck(this.fracId), 'The expert check could not be started.')
    }
  }

  download(): void {
    if (!this.canDownload) {
      return
    }
    this.autosave.flush()
    this.subs.add(
      this.api.exportFrac(this.fracId).subscribe({
        next: file => saveBlob(file.blob, file.filename),
        error: err => this.error = apiErrorMessage(err, 'The FRAC could not be downloaded.'),
      }),
    )
  }

  /**
   * Runs an AI step on the saved FRAC and opens its tab to watch the progress. Text in the step's box goes along as
   * instructions, unless the run already carries it as revise feedback.
   */
  runStep(step: FracGenStep, body: FracStepBody = {}): void {
    if (this.canRun) {
      const guidance = this.feedback[step].trim()
      const sent = guidance && !body.feedback ? { ...body, guidance } : body
      this.tab = step
      this.startJob(this.api.runStep(this.fracId, step, sent), 'The step could not be started.')
    }
  }

  private withFeedback(step: FracGenStep, body: FracStepBody): FracStepBody {
    const feedback = this.feedback[step].trim()
    return feedback ? { ...body, feedback } : body
  }

  private startJob(start: Observable<string>, failure: string): void {
    this.error = ''
    this.starting = true
    this.subs.add(
      start.pipe(switchMap(jobId => this.api.pollJob(jobId))).subscribe({
        next: job => {
          this.starting = false
          this.onJob(job)
        },
        error: err => {
          this.starting = false
          // The service allows one job per FRAC: follow the one already running instead of failing
          const live = runningJobId(err)
          if (live) {
            this.startJob(of(live), failure)
            return
          }
          this.job = null
          this.refreshDerived()
          this.error = apiErrorMessage(err, failure)
        },
      }),
    )
  }

  private onJob(job: FracJob): void {
    this.job = job
    this.refreshDerived()
    if (job.status === 'done') {
      if (GEN_STEPS.includes(job.kind as FracGenStep)) {
        this.feedback = { ...this.feedback, [job.kind]: '' }
        if (job.kind === 'competencies' && this.mappingSentRoles) {
          this.feedback = { ...this.feedback, roles: '' }
          this.mappingSentRoles = false
        }
      } else if (job.kind === 'fix-all') {
        this.feedback = { ...this.feedback, check: '' }
      }
      this.historyKey++
      // Edits made while a job ran get their own automatic mapping after the reload
      this.autoMapTried = false
      this.load(false)
    }
  }

  /** After a save, keep local edits typed since; otherwise take the server copy. */
  private onSaved(saved: Frac): void {
    if (!this.frac) {
      return
    }
    this.quickRefresh.next()
    this.setFrac(this.autosave.hasUnsaved ? { ...this.frac, rolesDirty: saved.rolesDirty, changedAt: saved.changedAt } : saved)
  }

  /** A content edit after the expert check makes it out of date (the service sets the same flag on save). */
  private staleCheck(): Partial<Frac> {
    return this.frac?.review ? { reviewStale: true } : {}
  }

  private applyLocal(patch: Partial<Frac>): void {
    if (this.frac) {
      this.setFrac({ ...this.frac, ...patch })
    }
  }

  private setFrac(frac: Frac): void {
    this.frac = frac
    this.refreshDerived()
    this.scheduleAutoMap()
  }

  private refreshDerived(): void {
    if (this.frac) {
      this.usedBy = usedByMap(this.frac)
      this.competencyCodes = new Set(this.frac.competencies.map(c => normalizeCode(c.code)))
      this.steps = fracProgress(this.frac, this.job, this.briefDocCount)
      const rolesDirty = this.frac.rolesDirty
      this.stale = staleSteps(this.frac)
        .filter((step): step is Exclude<FracStep, 'brief'> => step !== 'brief' && !(rolesDirty && step === 'roles'))
    }
  }

  private loadDocuments(): void {
    this.subs.add(
      this.api.listDocuments(this.fracId).subscribe({
        next: documents => {
          this.documents = documents
          this.refreshDerived() // the tracker depends on whether a job description is attached
        },
        // The page works without the list; uploads still report their own errors
        error: () => this.documents = [],
      }),
    )
  }

  private load(pickTab: boolean): void {
    this.loading = !this.frac
    this.subs.add(
      this.api.loadFrac(this.fracId).subscribe({
        next: ({ frac, activeJobId }) => {
          this.loading = false
          this.setFrac(frac)
          this.quickRefresh.next()
          // A reloaded page or a second tab picks the running step up again
          if (activeJobId && !this.job && !this.starting) {
            this.startJob(of(activeJobId), 'The running step could not be followed.')
          }
          if (pickTab) {
            this.tab = this.primary.step ?? 'check'
            this.loadDocuments()
          }
        },
        error: err => {
          this.loading = false
          this.error = apiErrorMessage(err, 'The FRAC could not be loaded.')
        },
      }),
    )
  }
}
