export class BackendError extends Error {
  constructor(public code: string, public httpStatus: number) { super(code) }
}
