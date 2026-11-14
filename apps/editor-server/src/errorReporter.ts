/** Receives failures that clients only see as a generic message. */
export type ErrorReporter = (context: string, error: unknown) => void

export const ignoreErrors: ErrorReporter = () => {}
