const body = () => Response.json({ success: false, code: 'InternalServerError' }, { status: 500 })
export const GET = body
export const POST = body
