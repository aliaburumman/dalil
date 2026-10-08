// Public API of `dalil`. Implementations live beside this file; this list is the
// contract the widget and host apps code against.
//
//   init(config)        start recording (idempotent). Patches fetch/XHR/history,
//                       listens for clicks/inputs/submits/errors. Safe to call early.
//   log(msg, data?, level?)  add a LogEvent (host hook, e.g. Zod drift).
//   getConfig()         current config or null.
//   snapshot()          { events, verdict, curls } for the last bufferMs, redacted.
//   classify(events, openedAt)  pure verdict function.
//   toCurl(event)       pure curl builder for a RequestEvent (+ its headers).
//   redact*             pure redaction helpers.
//   submit(payload, images)   POST multipart to config.endpoint, returns SubmitResult;
//                       on network failure stores one pending report in IndexedDB
//                       (24 h TTL) and flushPending() retries it on next init.
//   onEvent(cb)         subscribe to each recorded DalilEvent; returns unsubscribe.
//   open() / onOpen(cb) trigger the widget from host UI (button in a menu, etc).

export * from './types'
export { init, log, getConfig, snapshot, open, onOpen, onEvent, __resetForTests } from './recorder'
export { classify } from './classify'
export { toCurl } from './curl'
export { redactJsonString, redactUrl, redactText, redactHeaders } from './redact'
export { submit, flushPending } from './submit'
export { DalilSubmitError } from './submit'
export type { SubmitImage, SubmitErrorCode } from './submit'
export { LIMITS, IMAGE_PART, AUTO_PART, REPLAY_PART } from './limits'
