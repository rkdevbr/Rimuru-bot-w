import pg from 'pg';

const { Pool } = pg;
let pool = null;

function db() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!connectionString) return null;
  pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
  return pool;
}

export async function syncConsent(userId, status) {
  const client = db();
  if (!client || !userId) return false;
  const consentedAt = status === 'active' ? new Date() : null;
  const revokedAt = status === 'revoked' ? new Date() : null;
  await client.query(
    `insert into public.rimuru_antidelete_consent
      (whatsapp_user_id, status, requested_at, consented_at, revoked_at, updated_at)
     values ($1,$2,now(),$3,$4,now())
     on conflict (whatsapp_user_id) do update set
       status=excluded.status,
       consented_at=coalesce(excluded.consented_at, rimuru_antidelete_consent.consented_at),
       revoked_at=excluded.revoked_at,
       updated_at=now()`,
    [userId, status, consentedAt, revokedAt]
  );
  return true;
}

export async function cleanupExpiredAntiDelete() {
  const client = db();
  if (!client) return 0;
  const result = await client.query('select public.rimuru_cleanup_antidelete_buffer() as removed');
  return Number(result.rows?.[0]?.removed || 0);
}
