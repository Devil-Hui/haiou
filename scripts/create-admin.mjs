import 'dotenv/config';
import { eq } from 'drizzle-orm';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// Django createsuperuser 的设计初衷：创建唯一管理员，且「已存在就拒绝」而不是静默覆盖。
// 误执行不应该把线上管理员的密码改掉——想改凭据请显式使用 admin:reset。
//
// 三种输入方式，按优先级：
//   1. 环境变量 ADMIN_USERNAME / ADMIN_NEW_PASSWORD（CI、自动化、首台机器）
//   2. 交互式提问（TTY 本地，密码不回显、需二次确认）
//   3. 都没有 → 报错退出，不做任何猜测
//
// 用法：
//   npm run admin:create                 # 已存在则拒绝
//   npm run admin:create -- --force      # 显式覆盖（凭据轮换场景请改用 admin:reset）

const force = process.argv.includes('--force');
const envUsername = (process.env.ADMIN_USERNAME || '').trim();
const envPassword = process.env.ADMIN_NEW_PASSWORD || '';

// 终端下屏蔽回显，避免密码留在 scrollback / 录屏里。
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    stdout.write(prompt);
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004' || s === '\u0003') return;
      stdout.write('\b \b');
    };
    rl.input.on('data', onData);
    rl.question('', (answer) => {
      rl.input.off('data', onData);
      rl.close();
      stdout.write('\n');
      resolve(answer);
    });
  });
}

async function resolveCredentials() {
  if (envUsername && envPassword) return { username: envUsername, password: envPassword, source: 'env' };
  if (!stdin.isTTY) {
    throw new Error('缺少凭据：非交互环境下请同时设置 ADMIN_USERNAME 与 ADMIN_NEW_PASSWORD。');
  }
  stdout.write('创建唯一管理员。密码至少 12 位，且不能是常见弱口令、重复字符或包含用户名。\n\n');
  const username = (await readline.question('管理员用户名（3-30 位字母/数字/下划线/连字符）: ')).trim();
  const password = await askHidden('管理员密码（输入不回显）: ');
  const confirm = await askHidden('再次输入密码: ');
  if (password !== confirm) throw new Error('两次输入的密码不一致，未做任何修改。');
  return { username, password, source: '交互输入' };
}

async function main() {
  const { username, password, source } = await resolveCredentials();

  const { hashPassword, strongAdminPassword, validAdminUsername } = await import('../src/lib/auth/password.ts');
  if (!validAdminUsername(username)) throw new Error('用户名需为 3-30 位字母、数字、下划线或连字符。');
  if (password.length < 12 || password.length > 128) throw new Error('密码长度需在 12-128 字符之间。');
  if (!strongAdminPassword(password, username)) {
    throw new Error('密码过弱：避免常见口令、少于四个不同字符，或包含用户名。');
  }

  const { db, pool } = await import('../src/db/index.ts');
  const { admins } = await import('../src/db/schema.ts');

  try {
    const [existing] = await db.select({ id: admins.id, username: admins.username }).from(admins).limit(1);

    if (existing && !force) {
      // 关键安全约束：默认拒绝覆盖。管理员不在页面上注册，唯一入口是这条命令，
      // 因此绝不能因为一次误执行就把线上账号的凭据换掉。
      throw new Error(
        `管理员 "${existing.username}" 已存在，未做任何修改。\n` +
        `  · 要轮换现有凭据：npm run admin:reset\n` +
        `  · 确需覆盖（危险）：npm run admin:create -- --force`
      );
    }

    if (existing) {
      // 覆盖同样清空会话摘要，所有已登录设备立即失效。
      await db.update(admins)
        .set({ username, passwordHash: hashPassword(password), sessionHash: null, sessionExpires: null })
        .where(eq(admins.id, existing.id));
      console.log(`已覆盖管理员 "${existing.username}" -> "${username}"（来源：${source}）。所有已登录会话已失效。`);
    } else {
      await db.insert(admins).values({ id: 1, username, passwordHash: hashPassword(password) }).onConflictDoNothing();
      console.log(`管理员 "${username}" 已创建（来源：${source}）。请到 /admin-login 登录。`);
    }
    console.log('提示：密码不会回显、不写入日志，请勿放进 shell 历史或工单。');
  } finally {
    await pool.end();
  }
}

// CLI 顶层只给出可读原因，不吐堆栈——运维看到栈也用不上。
main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
