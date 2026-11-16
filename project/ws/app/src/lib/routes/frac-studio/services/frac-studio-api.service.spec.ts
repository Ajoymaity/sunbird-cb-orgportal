import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing'
import { TestBed } from '@angular/core/testing'
import { FracStudioApiService } from './frac-studio-api.service'

describe('FracStudioApiService', () => {
  let service: FracStudioApiService
  let httpMock: HttpTestingController

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule], providers: [FracStudioApiService] })
    service = TestBed.inject(FracStudioApiService)
    httpMock = TestBed.inject(HttpTestingController)
  })

  afterEach(() => httpMock.verify())

  it('fixes every open finding with an empty body', () => {
    let jobId = ''
    service.fixAll('f1').subscribe(id => jobId = id)
    const req = httpMock.expectOne('/apis/protected/v8/fracStudio/fracs/f1/fixes/all')
    expect(req.request.method).toBe('POST')
    expect(req.request.body).toEqual({})
    req.flush({ jobId: 'job-1' })
    expect(jobId).toBe('job-1')
  })

  it('fixes one finding by its title', () => {
    service.fixAll('f1', ['Outdated reference: TT / tetanus toxoid']).subscribe()
    const req = httpMock.expectOne('/apis/protected/v8/fracStudio/fracs/f1/fixes/all')
    expect(req.request.body).toEqual({ titles: ['Outdated reference: TT / tetanus toxoid'] })
    req.flush({ jobId: 'job-2' })
  })

  it('deletes a FRAC', () => {
    let done = false
    service.deleteFrac('f 1').subscribe(() => done = true)
    const req = httpMock.expectOne('/apis/protected/v8/fracStudio/fracs/f%201')
    expect(req.request.method).toBe('DELETE')
    req.flush(null, { status: 204, statusText: 'No Content' })
    expect(done).toBe(true)
  })
})
