#!/usr/bin/env node
// scripts/deploy.js — One-command deploy for Jarvis + Playground
// Usage: node scripts/deploy.js            (full deploy)
//        node scripts/deploy.js --no-build (skip frontend build)
//        npm run deploy                    (via package.json)

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLAYGROUND = path.join(ROOT, 'src', 'playground');
const NO_BUILD = process.argv.includes('--no-build');
const FORCE = process.argv.includes('--force');

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
      console.log(`    ⚠️  ${err.message.split('\n')[0]}`);
      return null;
    }
    throw err;
  }
}

function exists(p) { return fs.existsSync(p); }
function isPm2Available() {
  try { execSync('pm2 --version', { stdio: 'pipe' }); return true; } catch { return false; }
}

// ── Steps ────────────────────────────────────────────────────────────────────

const steps = [
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
      run('npm install --production=false', { label: 'npm install (root)' });
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
    name: 'Install frontend dependencies',
    skip: NO_BUILD,
    run() {
      if (!exists(path.join(PLAYGROUND, 'node_modules'))) {
        run('npm install', { cwd: PLAYGROUND, label: 'npm install (playground)' });
      } else {
        console.log('    ✅ already installed');
      }
    },
  },
  {
    name: 'Build playground frontend',
    skip: NO_BUILD,
    run() {
      run('npm run build', { cwd: PLAYGROUND, label: 'vite build', timeout: 120000 });
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
        // Spawn the server in foreground
        const child = spawn('node', ['src/index.js'], {
          cwd: ROOT,
          stdio: 'inherit',
          env: process.env,
        });
        child.on('exit', (code) => {
          console.log(`\nServer exited with code ${code}`);
          process.exit(code || 0);
        });
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
    step.run();
  } catch (err) {
    console.log(`\n❌ FAILED: ${step.name}`);
    console.log(`   ${err.message.split('\n')[0]}`);
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
  process.exit(1);
}
