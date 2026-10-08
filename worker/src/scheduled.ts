// Daily cron: retention (D1 rows past 90 days; R2 objects expire via a lifecycle rule,
// see README) and email retries for rows marked failed within the last 7 days.
import { deliverEmail } from './email'
import { DAY_MS, type Env, type ProjectRow, RETENTION_MS, type ReportRow } from './env'

export async function runScheduled(env: Env, now = Date.now()): Promise<{ deleted: number; retried: number }> {
  const del = await env.DB.prepare('DELETE FROM reports WHERE created_at < ?').bind(now - RETENTION_MS).run()
  await env.DB.prepare('DELETE FROM ingest_hits WHERE at < ?').bind(now - DAY_MS).run()

  // 'failed' within 7 days, plus 'pending' rows older than an hour (the waitUntil was lost).
  const { results } = await env.DB.prepare(
    `SELECT * FROM reports
     WHERE created_at >= ?1 AND (email_status = 'failed' OR (email_status = 'pending' AND created_at < ?2))
     ORDER BY created_at LIMIT 50`,
  )
    .bind(now - 7 * DAY_MS, now - 3_600_000)
    .all<ReportRow>()

  const projects = new Map<string, ProjectRow | null>()
  let retried = 0
  for (const row of results) {
    if (!projects.has(row.project_id)) {
      projects.set(row.project_id, await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(row.project_id).first<ProjectRow>())
    }
    const project = projects.get(row.project_id)
    if (!project) continue
    await deliverEmail(env, row, project)
    retried++
  }
  return { deleted: del.meta.changes ?? 0, retried }
}
