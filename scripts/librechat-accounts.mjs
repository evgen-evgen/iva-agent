#!/usr/bin/env node
// Provision exactly two local LibreChat accounts without opening browser sign-up.
import { spawnSync } from 'node:child_process';

const checkOnly = process.argv[2] === '--check';
const emails = process.argv.slice(checkOnly ? 3 : 2).map((email) => email.trim().toLowerCase());

if (
  emails.length !== 2 ||
  emails[0] === emails[1] ||
  emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
) {
  console.error('Usage: npm run librechat:accounts -- [--check] <admin-email> <ceo-email>');
  process.exit(2);
}

const mongoPort = process.env.LIBRECHAT_MONGO_PORT || '27018';
if (!/^\d{1,5}$/.test(mongoPort) || Number(mongoPort) > 65535) {
  throw new Error('Invalid LIBRECHAT_MONGO_PORT');
}

function compose(args, stdio = 'pipe') {
  const result = spawnSync('docker', ['compose', '--profile', 'librechat', ...args], {
    encoding: 'utf8',
    stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker compose failed (${result.status}): ${result.stderr?.trim() || ''}`);
  }
  return result.stdout;
}

function mongo(script, allowedEmails = emails) {
  return compose([
    'exec',
    '-T',
    '-e',
    `IVA_ACCOUNT_EMAILS=${JSON.stringify(allowedEmails)}`,
    'librechat-mongodb',
    'mongosh',
    '--quiet',
    '--port',
    mongoPort,
    'LibreChat',
    '--eval',
    script,
  ]).trim();
}

function readAccounts() {
  const output = mongo(
    'print(JSON.stringify(db.users.find({}, { _id: 0, email: 1, role: 1 }).toArray()))',
  );
  const accounts = JSON.parse(output.split(/\r?\n/).at(-1));
  if (!Array.isArray(accounts)) throw new Error('Could not read LibreChat accounts');
  return accounts;
}

function assertAllowed(accounts) {
  const found = new Set();
  for (const account of accounts) {
    const email = account.email?.toLowerCase();
    if (!emails.includes(email) || found.has(email)) {
      throw new Error('Unexpected or duplicate LibreChat account found. Review MongoDB users first.');
    }
    found.add(email);
  }
  return found;
}

try {
  let accounts = readAccounts();
  const existing = assertAllowed(accounts);

  if (!checkOnly) {
    for (const email of emails) {
      if (existing.has(email)) continue;
      console.log(`Creating ${email}. Enter this address and a private password at the prompts.`);
      compose(['exec', 'librechat', 'sh', '-lc', 'cd /app && npm run create-user'], 'inherit');
      accounts = readAccounts();
      assertAllowed(accounts);
      if (!accounts.some((account) => account.email.toLowerCase() === email)) {
        throw new Error(`Expected account ${email} was not created`);
      }
    }

    // Promotion happens only after the DB contains exactly the requested accounts.
    if (accounts.length !== 2) throw new Error('Expected exactly two LibreChat accounts');
    const storedEmails = accounts.map((account) => account.email);
    const output = mongo(
      'const emails=JSON.parse(process.env.IVA_ACCOUNT_EMAILS);' +
        'const result=db.users.updateMany({email:{$in:emails}},{$set:{role:"ADMIN"}});' +
        'print(JSON.stringify({matched:result.matchedCount}))',
      storedEmails,
    );
    if (JSON.parse(output.split(/\r?\n/).at(-1)).matched !== 2) {
      throw new Error('Could not promote both LibreChat accounts');
    }
  }

  accounts = readAccounts();
  assertAllowed(accounts);
  if (accounts.length !== 2 || accounts.some((account) => account.role !== 'ADMIN')) {
    throw new Error('Expected exactly two LibreChat accounts with ADMIN role');
  }
  console.log('LibreChat accounts: exactly two, both ADMIN; browser registration stays disabled.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
