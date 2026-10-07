import 'dotenv/config';
import { eq } from 'drizzle-orm';

const password = process.env.ADMIN_NEW_PASSWORD || '';
const username = (process.env.ADMIN_USERNAME || '').trim();

if (!password) throw new Error('Set ADMIN_NEW_PASSWORD (12-128 characters) before running this script.');

const { hashPassword, strongAdminPassword, validAdminUsername } = await import('../src/lib/auth/password.ts');
if (password.length < 12 || password.length > 128) throw new Error('ADMIN_NEW_PASSWORD must be 12-128 characters.');
if (username && !validAdminUsername(username)) throw new Error('ADMIN_USERNAME must be 3-30 letters, digits, underscores or hyphens.');

const { db, pool } = await import('../src/db/index.ts');
const { admins } = await import('../src/db/schema.ts');

try {
  const [admin] = await db.select({ id: admins.id, username: admins.username }).from(admins).limit(1);
  if (!admin) {
    // 管理员注册不在页面上：首次部署由本脚本在服务器上直接创建唯一管理员。
    if (!username) throw new Error('No administrator exists yet. Set ADMIN_USERNAME to create the first one.');
    if (!strongAdminPassword(password, username)) throw new Error('ADMIN_NEW_PASSWORD is too weak: avoid common passwords, fewer than four distinct characters, or anything containing the username.');
    await db.insert(admins).values({ id: 1, username, passwordHash: hashPassword(password) }).onConflictDoNothing();
    console.log(`Administrator "${username}" created. Sign in at /admin-login.`);
  } else {
    const nextUsername = username || admin.username;
    // Full strength rule is checked here, where the final username is known, so the
    // "password must not contain the username" part can actually be enforced.
    if (!strongAdminPassword(password, nextUsername)) throw new Error('ADMIN_NEW_PASSWORD is too weak: avoid common passwords, fewer than four distinct characters, or anything containing the username.');
    // Rewriting the hash also clears the stored session digest, so every device currently
    // signed in is logged out the moment this runs.
    await db.update(admins).set({ username: nextUsername, passwordHash: hashPassword(password), sessionHash: null, sessionExpires: null }).where(eq(admins.id, admin.id));
    console.log(`Credentials updated for administrator "${nextUsername}". All active sessions were revoked; sign in again at /admin-login.`);
  }
} finally {
  await pool.end();
}
