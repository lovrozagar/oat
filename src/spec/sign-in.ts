/** How a document names its sign-in routes, as oat reads them when nothing is tagged. */

/** A path or name that signs a caller in, mints a token, or opens a session. */
export const SIGN_IN: RegExp = /login|token|session/i
