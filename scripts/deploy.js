#!/usr/bin/env node
// scripts/deploy.js — One-command deploy for Jarvis
// Usage: node scripts/deploy.js              (full deploy)
//        node scripts/deploy.js --fix-perms  (fix ownership then deploy)
//        npm run deploy                      (via package.json)

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const FORCE = process.argv.includes('--force');
const FIX_PERMS = process.argv.includes('--fix-perms');

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  const label = opts.label || cmd;
  process.stdout.write(`  ${label}... `);
  try {
    const output = execSync(cmd, {
      cwd: opts.cwd || ROOT,
      stdio: opts.silent ? 'pipe' : 'inherit',
      timeout: opts.timeout || 120000,
      env: { ...process.env, ...(opts.env || {}) },
    });
    console.log('✅');
    return output;
  } catch (err) {
    console.log('❌');
    if (opts.ignoreError) {
      const msg = (err.stderr || err.message || '').toString().split('\n').slice(0, 3).join('\n');
      console.log(`    ⚠️  ${msg}`);
      return null;
    }
    throw err;
  }
}

function exists(p) { return fs.existsSync(p); }
function isPm2Available() {
  try { execSync('pm2 --version', { stdio: 'pipe' }); return true; } catch { return false; }
}

function whoami() {
  try { return execSync('whoami', { stdio: 'pipe' }).toString().trim(); } catch { return 'unknown'; }
}

function statOwner(dir) {
  try {
    const uid = fs.statSync(dir).uid;
    // Try to resolve UID to username
    try { return execSync(`stat -c '%U' "${dir}"`, { stdio: 'pipe' }).toString().trim(); } catch { return `uid:${uid}`; }
  } catch { return 'unknown'; }
}

function canWrite(dir) {
  try {
    const testFile = path.join(dir, '.deploy-write-test');
    fs.writeFileSync(testFile, 'test', { flag: 'w' });
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

const steps = [
  {
    name: 'Check permissions',
    run() {
      const user = whoami();
      const owner = statOwner(ROOT);

      console.log(`    User:  ${user}`);
      console.log(`    Owner: ${owner}`);
      console.log(`    Dir:   ${ROOT}`);

      if (FIX_PERMS) {
        // Try to fix ownership with sudo
        console.log('    🔧 Fixing ownership (sudo chown)...');
        try {
          execSync(`sudo chown -R ${user}:${user} "${ROOT}"`, { stdio: 'inherit' });
          console.log('    ✅ Ownership fixed');
          return;
        } catch {
          console.log('    ⚠️  sudo chown failed. Trying manual fix...');
          console.log('    Run this manually:');
          console.log(`       sudo chown -R ${user}:${user} ${ROOT}`);
          throw new Error('Cannot fix permissions automatically. Run the command above, then retry.');
        }
      }

      const writable = canWrite(ROOT);
      if (!writable) {
        console.log('    ❌ Cannot write to project directory!');
        console.log('');
        console.log('    🔧 Fix with one of these:');
        console.log('');
        console.log('       Option 1 (auto-fix):');
        console.log('         npm run deploy -- --fix-perms');
        console.log('');
        console.log('       Option 2 (manual):');
        console.log(`         sudo chown -R ${user}:${user} ${ROOT}`);
        console.log('');
        console.log('       Option 3 (run as root):');
        console.log('         sudo npm run deploy');
        console.log('');
        throw new Error('Permission denied — project directory not writable by current user.');
      }

      console.log('    ✅ Write permission OK');
    },
  },
  {
    name: 'Check environment',
    run() {
      const envFile = path.join(ROOT, '.env');
      if (!exists(envFile)) {
        if (exists(path.join(ROOT, '.env.example'))) {
          console.log('    ⚠️  .env not found! Copy .env.example to .env and fill it in.');
          console.log('       cp .env.example .env');
        } else {
          console.log('    ⚠️  .env not found! Create it with required vars:');
          console.log('       TELEGRAM_BOT_TOKEN=...');
          console.log('       TELEGRAM_OWNER_ID=...');
          console.log('       DEEPSEEK_API_KEY=...');
          console.log('       DATABASE_URL=...');
        }
        if (!FORCE) throw new Error('Missing .env file. Use --force to skip.');
        console.log('    ⚠️  --force: continuing without .env');
      } else {
        console.log('    ✅ .env found');
      }
    },
  },
  {
    name: 'Install backend dependencies',
    run() {
      // Use --prefer-offline to speed up; fall back to regular install
      run('npm install --production=false --prefer-offline', { label: 'npm install (root)', ignoreError: true })
        || run('npm install --production=false', { label: 'npm install (root, retry)' });
    },
  },
  {
    name: 'Setup database',
    ignoreError: true,
    run() {
      run('node scripts/setup-db.js', { label: 'DB setup', ignoreError: true });
    },
  },
  {
    name: 'Start / restart server',
    run() {
      if (isPm2Available()) {
        const appName = 'jarvis';
        try {
          execSync(`pm2 list | grep -q "${appName}"`, { stdio: 'pipe' });
          console.log('    🔄 PM2 reload...');
          execSync(`pm2 reload ${appName} --update-env`, { stdio: 'inherit' });
        } catch {
          console.log('    🆕 PM2 start...');
          execSync(`pm2 start src/index.js --name ${appName} --max-memory-restart 512M`, {
            cwd: ROOT, stdio: 'inherit',
          });
          execSync('pm2 save', { stdio: 'inherit' });
        }
      } else {
        console.log('    ℹ️  PM2 not found — starting directly (npm start)');
        console.log('    💡 Install PM2 for production: npm i -g pm2');
        console.log('');
        const child = spawn('node', ['src/index.js'], {
          cwd: ROOT,
          stdio: 'inherit',
          env: process.env,
        });
        child.on('exit', (code) => {
          console.log(`\nServer exited with code ${code}`);
          process.exit(code || 0);
        });
        // Don't proceed past this step since server is running in foreground
        return 'running';
      }
    },
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('');
console.log('🚀  Jarvis Deploy  —  ' + new Date().toLocaleString());
console.log('═'.repeat(50));
console.log('');

let failed = false;

for (const step of steps) {
  if (step.skip) {
    console.log(`⏭️  SKIP: ${step.name}`);
    continue;
  }
  console.log(`📋 ${step.name}`);
  try {
    const result = step.run();
    if (result === 'running') {
      // Server is running in foreground — don't print deploy complete
      failed = false;
      break;
    }
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().split('\n')[0];
    console.log(`\n❌ FAILED: ${step.name}`);
    console.log(`   ${msg}`);
    failed = true;
    break;
  }
  console.log('');
}

if (!failed) {
  console.log('═'.repeat(50));
  console.log('✅  Deploy complete!');
  console.log('');
  const port = process.env.PORT || 3000;
  console.log('   API:       http://localhost:' + port);
  console.log('   Dashboard: http://localhost:' + port + '  (after build)');
  console.log('   Health:    http://localhost:' + port + '/health');
  console.log('');
} else {
  console.log('\n⚠️  Deploy failed. Fix the issue above and try again.');
  console.log('   Hint: if it is a permission error, try:');
  console.log('     npm run deploy -- --fix-perms');
  process.exit(1);
}

