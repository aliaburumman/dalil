// Strict CSP on every route. style-src has no 'unsafe-inline': the widget must style itself with
// adoptedStyleSheets. script-src keeps 'unsafe-inline' only because Next's bootstrap scripts are inline.
const collector = process.env.NEXT_PUBLIC_DALIL_ENDPOINT ? new URL(process.env.NEXT_PUBLIC_DALIL_ENDPOINT).origin : ''
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${collector} https://dev.azure.com`,
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

export default {
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: csp }] }]
  },
}
