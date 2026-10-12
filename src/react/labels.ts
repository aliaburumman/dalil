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
  /** v0.2.1 labels, optional. */
  unreachable?: string
  buildFailed?: string
  /** Prefix of the 'User saw' line. */
  userSaw?: string
  /** v0.2 labels are optional so existing hosts still compile; English defaults apply. */
  autoCaptured?: string
  removeAutoCaptured?: string
  /** {duration} = e.g. "1m 48s" */
  screenRecording?: string
  includeRecording?: string
  preparingRecording?: string
  /** Sent panel (optional so existing hosts compile; English defaults apply). */
  copyReport?: string
  copied?: string
  copyFailed?: string
  done?: string
  /** Azure DevOps mode (all optional; English defaults apply). {org} {project} {type} {id} {n} are filled in. */
  adoConnectTitle?: string
  adoConnectIntro?: string
  adoTokenLabel?: string
  adoCreateToken?: string
  adoValidate?: string
  adoValidating?: string
  adoForget?: string
  adoMemoryOnly?: string
  adoErrAuth?: string
  adoErrForbidden?: string
  adoErrNotFound?: string
  adoErrUnreachable?: string
  adoSentAs?: string
  adoOpen?: string
  adoPartial?: string
  adoTokenExpired?: string
  adoNoAccess?: string
  adoUpdateToken?: string
  adoDownload?: string
  adoDownloadFailed?: string
  adoTryAgain?: string
  adoRejected?: string
  adoBadConfig?: string
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
  unreachable:
    "Couldn't reach the bug-report server. Your report is saved on this device and will be retried automatically; please tell the team.",
  buildFailed: 'Something went wrong preparing the report. Please try again.',
  userSaw: 'User saw',
  copyReport: 'Copy report',
  copied: 'Copied',
  copyFailed: "Couldn't copy",
  done: 'Done',
  adoConnectTitle: 'Connect Azure DevOps',
  adoConnectIntro:
    'Reports are filed in {org} / {project} as you. Paste a personal access token with only the Work Items (Read & write) scope and an expiry of 30 days or less. It stays in this browser.',
  adoTokenLabel: 'Personal access token',
  adoCreateToken: 'Create a token in Azure DevOps',
  adoValidate: 'Validate & save',
  adoValidating: 'Checking…',
  adoForget: 'Forget token',
  adoMemoryOnly: 'Browser storage is unavailable here, so the token is kept only until you close this page.',
  adoErrAuth: 'Azure DevOps rejected this token. Check that it is correct, still active and has Work Items (Read & write).',
  adoErrForbidden: "This token can't read work items in {project}. Check its scope and project access.",
  adoErrNotFound: "Project '{project}' was not found in '{org}'. Check the names.",
  adoErrUnreachable: "Couldn't reach Azure DevOps org '{org}'. Check the org name, then try again.",
  adoSentAs: 'Created {type} #{id}',
  adoOpen: 'Open in Azure DevOps',
  adoPartial: "{n} image(s) couldn't be attached, see the report.",
  adoTokenExpired: 'Your Azure DevOps token expired or was revoked.',
  adoNoAccess: "Your token can't create work items in {project} (check its scope and project access).",
  adoUpdateToken: 'Update token',
  adoDownload: 'Download evidence (.zip)',
  adoDownloadFailed: 'The download was blocked. Use Copy report instead.',
  adoTryAgain: 'Try again',
  adoRejected: 'Azure DevOps rejected the work item. Check the work item type and body field in the setup.',
  adoBadConfig: 'The Azure DevOps destination needs an org and a project.',
  saveFailed: "You appear to be offline and the report couldn't be saved. Please try again.",
}

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** A label with its English default (for the optional ones). */
export function pick(labels: Labels, key: keyof Labels): string {
  return labels[key] ?? defaultLabels[key] ?? ''
}
