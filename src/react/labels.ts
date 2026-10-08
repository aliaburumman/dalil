/** Every user-facing string in the widget. Hosts override any subset via `labels`. */
export interface Labels {
  button: string
  dialogTitle: string
  close: string
  screenshot: string
  screenshotFailed: string
  toolPen: string
  toolRect: string
  toolBlur: string
  undo: string
  whatWentWrong: string
  whatExpected: string
  severity: string
  severityBlocker: string
  severityAnnoying: string
  severityMinor: string
  images: string
  imagesHint: string
  addImage: string
  removeImage: string
  imageLimit: string
  imageFailed: string
  whatWillBeSent: string
  likely: string
  /** {n} = number of steps */
  steps: string
  /** Used when n === 1. Optional so existing hosts compile. */
  stepsOne?: string
  /** {n} = requests, {m} = failed */
  requests: string
  /** Used when n === 1. {n} = 1, {m} = failed */
  requestsOne?: string
  contextFields: string
  noContext: string
  cancel: string
  send: string
  sending: string
  /** {ref} = report reference, e.g. SPACE-142 */
  sentAs: string
  queued: string
  rejected: string
  saveFailed: string
  /** v0.2 labels are optional so existing hosts still compile; English defaults apply. */
  autoCaptured?: string
  removeAutoCaptured?: string
  /** {duration} = e.g. "1m 48s" */
  screenRecording?: string
  includeRecording?: string
  preparingRecording?: string
}

export const defaultLabels: Labels = {
  button: 'Report a bug',
  dialogTitle: 'Report a bug',
  close: 'Close',
  screenshot: 'Screenshot',
  screenshotFailed: "We couldn't capture the screen. Paste or upload a screenshot below if it helps.",
  toolPen: 'Pen',
  toolRect: 'Box',
  toolBlur: 'Blur',
  undo: 'Undo',
  whatWentWrong: 'What went wrong?',
  whatExpected: 'What did you expect?',
  severity: 'How bad is it?',
  severityBlocker: 'Blocker',
  severityAnnoying: 'Annoying',
  severityMinor: 'Minor',
  images: 'More images',
  imagesHint: 'Paste, drop or choose up to 5 images',
  addImage: 'Choose images',
  removeImage: 'Remove image',
  imageLimit: 'You can add up to 5 images.',
  imageFailed: "That image couldn't be added.",
  whatWillBeSent: 'What will be sent',
  likely: 'Likely',
  steps: '{n} steps',
  stepsOne: '{n} step',
  requests: '{n} requests ({m} failed)',
  requestsOne: '{n} request ({m} failed)',
  contextFields: 'Context',
  noContext: 'None',
  cancel: 'Cancel',
  send: 'Send',
  sending: 'Sending…',
  sentAs: 'Sent as {ref}',
  queued: 'Saved, will send when back online',
  rejected: "The report couldn't be sent. Please try again.",
  autoCaptured: 'Captured automatically',
  removeAutoCaptured: 'Remove this capture',
  screenRecording: 'Screen recording: last {duration} (inputs hidden)',
  includeRecording: 'Include the screen recording',
  preparingRecording: 'Preparing recording…',
  saveFailed: "You appear to be offline and the report couldn't be saved. Please try again.",
}

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
