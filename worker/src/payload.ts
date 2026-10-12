// Payload contract: re-exported from ../../shared/payload, the single source shared
// with the widget (bundled by wrangler, so no copy to keep in sync). Bump
// PAYLOAD_VERSION there when the shape changes and make the collector accept it.
import type { ReportPayload as ClientReportPayload } from '../../shared/payload'

export * from '../../shared/payload'

export const SUPPORTED_VERSIONS: readonly number[] = [1, 2]

// The collector accepts v1 reports; the widget only emits PAYLOAD_VERSION.
export type ReportPayload = Omit<ClientReportPayload, 'v'> & { v: 1 | 2 }
