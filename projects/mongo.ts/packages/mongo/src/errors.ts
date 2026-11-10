// Error envelope for the MongoDB product surface.
//
// Every failure raised by this package — configuration, lifecycle, transport
// or a server reply — carries the same locating fields: which product spoke
// (`product`), which stage failed (`phase`), whether the command ever reached
// the engine (`execution`) and whether repeating it is safe (`retry`).
// `retry` is advice for the application, never an instruction this package
// acts on by itself.

export type MongoErrorPhase = 'configuration' | 'open' | 'connect' | 'execute' | 'commit' | 'close'
export type MongoErrorExecution = 'not-sent' | 'unknown' | 'replied'
export type MongoErrorRetry = 'never' | 'safe' | 'application-decision'

export interface MongoErrorDetails {
    /** Stable machine-readable code: the server code as text, or a product name. */
    code: string
    /** Symbolic name; defaults to `code` for locally raised failures. */
    codeName?: string
    phase: MongoErrorPhase
    execution: MongoErrorExecution
    retry?: MongoErrorRetry
    /** Raw numeric wire code when the failure came from a server reply. */
    serverCode?: number
    errorLabels?: string[]
    cause?: unknown
}

export class MongoError extends Error {
    readonly product: 'mongodb' = 'mongodb'
    readonly code: string
    readonly codeName: string
    readonly phase: MongoErrorPhase
    readonly execution: MongoErrorExecution
    readonly retry: MongoErrorRetry
    readonly serverCode?: number
    readonly errorLabels: string[] | null

    constructor(message: string, details: MongoErrorDetails) {
        super(message, details.cause === undefined ? undefined : { cause: details.cause })
        this.name = 'MongoError'
        this.code = details.code
        this.codeName = details.codeName ?? details.code
        this.phase = details.phase
        this.execution = details.execution
        this.retry = details.retry ?? 'never'
        this.serverCode = details.serverCode
        this.errorLabels = details.errorLabels ?? null
    }
}
