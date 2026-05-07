#!/usr/bin/env node
/**
 * Надёжный clean-rebuild pipeline для расширения.
 *
 * Решает проблему: Plasmo HMR-watcher держит .plasmo/cache/parcel/data.mdb
 * залоченным, и обычный 'plasmo build' переиспользует кэш с предыдущей
 * сборки — фиксы в исходниках не попадают в бандл, юзер получает старый
 * сломанный код.
 *
 * Стратегия: НЕ убиваем чужие процессы (могли бы убить сами себя).
 * Вместо этого переименовываем залоченные папки в *.trash-<ts>/ — даже
 * залоченные файлы можно переименовать, и Plasmo создаёт новые.
 *
 * Что делает:
 *  1. Переименовывает .plasmo, .parcel-cache, build/ в trash (если есть).
 *  2. Бампит patch-версию в package.json (детерминированно).
 *  3. Запускает plasmo build → build/chrome-mv3-prod/.
 *  4. Копирует prod → dev, чтобы extension ID не сменился.
 *  5. Регрессионные проверки наличия critical patterns в бандле.
 *  6. Отчёт.
 *
 * Использование: npm run rebuild
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(__dirname, '..');
const PKG_PATH = join(EXT_ROOT, 'package.json');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

function fail(msg) {
  console.error(C.red('✘  ') + msg);
  process.exit(1);
}

// ===== STEP 1: Move locked folders to trash ===============================

function nukeCaches() {
  log('🧹', 'Step 1/5: Перемещаю кэши в *.trash (даже если залочены)...');
  const ts = Date.now();
  for (const dir of ['.plasmo', '.parcel-cache', 'build']) {
    const p = join(EXT_ROOT, dir);
    if (!existsSync(p)) continue;
    try {
      renameSync(p, join(EXT_ROOT, `${dir}.trash-${ts}`));
      console.log(`   ${C.dim('renamed')} ${dir} → ${dir}.trash-${ts}`);
    } catch (e) {
      console.log(`   ${C.yellow('⚠')} не удалось переименовать ${dir}: ${e.message}`);
    }
  }
  // Игнорим node_modules/.cache — обычно не мешает
}

// ===== STEP 2: Bump patch version =========================================

function bumpPatchVersion() {
  log('🔢', 'Step 2/5: Бампаю patch версию в package.json...');
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const [maj, min, patch] = pkg.version.split('.').map(Number);
  const newVersion = `${maj}.${min}.${patch + 1}`;
  pkg.version = newVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`   ${C.dim(pkg.version + ' (was ' + maj + '.' + min + '.' + patch + ')')}`);

  // Также обновляем PLASMO_PUBLIC_EXTENSION_VERSION в .env файлах чтобы Plasmo
  // запек версию в бандл (видна в console.info при загрузке расширения).
  for (const env of ['.env', '.env.production', '.env.development']) {
    const ep = join(EXT_ROOT, env);
    if (!existsSync(ep)) continue;
    let content = readFileSync(ep, 'utf8');
    if (content.includes('PLASMO_PUBLIC_EXTENSION_VERSION')) {
      content = content.replace(/PLASMO_PUBLIC_EXTENSION_VERSION=.*/, `PLASMO_PUBLIC_EXTENSION_VERSION=${newVersion}`);
    } else {
      if (!content.endsWith('\n')) content += '\n';
      content += `PLASMO_PUBLIC_EXTENSION_VERSION=${newVersion}\n`;
    }
    writeFileSync(ep, content);
  }
  return newVersion;
}

// ===== STEP 3: Run plasmo build ============================================

function runPlasmoBuild() {
  log('🏗️ ', 'Step 3/5: Запускаю plasmo build...');
  try {
    execSync('npx plasmo build', { cwd: EXT_ROOT, stdio: 'inherit' });
  } catch (e) {
    fail('plasmo build упал. Смотри лог выше.');
  }
}

// ===== STEP 4: Copy prod → dev =============================================

function copyProdToDev() {
  log('📋', 'Step 4/5: Копирую chrome-mv3-prod → chrome-mv3-dev...');
  const prodDir = join(EXT_ROOT, 'build', 'chrome-mv3-prod');
  const devDir = join(EXT_ROOT, 'build', 'chrome-mv3-dev');

  if (!existsSync(prodDir)) fail('build/chrome-mv3-prod/ не существует — Plasmo не собрался');

  function cpRecursive(src, dst) {
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const sp = join(src, entry.name);
      const dp = join(dst, entry.name);
      if (entry.isDirectory()) cpRecursive(sp, dp);
      else copyFileSync(sp, dp);
    }
  }
  cpRecursive(prodDir, devDir);
}

// ===== STEP 5: Regression canary ===========================================

function findBundleFile() {
  const dir = join(EXT_ROOT, 'build', 'chrome-mv3-dev');
  const files = readdirSync(dir);
  const zalo = files.find((f) => f.startsWith('zalo.') && f.endsWith('.js'));
  const popup = files.find((f) => f.startsWith('popup.') && f.endsWith('.js'));
  if (!zalo || !popup) fail('Не нашёл zalo.*.js / popup.*.js в build/chrome-mv3-dev/');
  return { zalo: join(dir, zalo), popup: join(dir, popup) };
}

// Регрессионные проверки contents/zalo.ts бандла. Минификатор Plasmo:
// - 'new Map()' минимизируется в 'new Map' (без скобок) или 'new Map;'
// - 8000 → 8e3 (scientific notation)
// - Локальные переменные переименовываются в одиночные буквы
// - Поэтому проверяем СТРУКТУРНЫЕ признаки, не имена переменных.
const REGRESSION_CHECKS = [
  { pattern: /addEventListener\(\s*['"]scroll['"]/, name: 'Scroll listener (history pagination)' },
  { pattern: /setInterval\([^,]+,8e3\)/, name: 'Safety-net rescan interval (8 sec)' },
  { pattern: /new Map[\s,;()]/, name: 'Map instantiation (chat-key cache + pending dedup)' },
  { pattern: /chrome\.runtime\?\.id/, name: 'Context-invalidated guard' },
  { pattern: /pointerdown/, name: 'Draggable chip pointer events' },
  { pattern: /data-zb-msg-id/, name: 'Overlay dedup attribute' },
  // i18n keys (свойства объектов не минифицируются)
  { pattern: /onboardTitle/, name: 'I18N onboarding title key' },
  { pattern: /chipPartnerLang/, name: 'I18N chip partner-lang key' },
  { pattern: /statusTranslating/, name: 'I18N status translating' },
  { pattern: /previewLabel/, name: 'I18N preview label' },
  // Sync с сервером
  { pattern: /\/settings\/chats/, name: 'Server sync endpoint reference' },
  // Auto-detect language: minifier escapes 'không' → 'kh\xf4ng'
  { pattern: /kh\\x[fF]4ng|kh\\u00[fF]4ng|không/, name: 'VI common-words detection' },
];

function regressionCanary({ zalo }) {
  log('🔍', 'Step 5/5: Regression canary — критические фиксы должны быть в бандле...');
  const zaloContent = readFileSync(zalo, 'utf8');
  let failed = 0;
  for (const { pattern, name } of REGRESSION_CHECKS) {
    if (pattern.test(zaloContent)) {
      console.log(`   ${C.green('✓')} ${name}`);
    } else {
      console.log(`   ${C.red('✘')} ${name}  ${C.dim('(pattern: ' + pattern + ')')}`);
      failed++;
    }
  }
  if (failed > 0) fail(`${failed} regression check(s) failed — фикс отсутствует в бандле!`);
}

// ===== Final summary =======================================================

function printSummary({ zalo, popup }, version) {
  const zaloStat = statSync(zalo);
  const popupStat = statSync(popup);
  console.log('');
  console.log(C.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(C.green(`✓ Build готов · v${version}`));
  console.log(C.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`  Bundle:  ${C.cyan(zalo.split(/[\\/]/).pop())}  ${C.dim((zaloStat.size / 1024).toFixed(1) + ' KB')}`);
  console.log(`  Popup:   ${C.cyan(popup.split(/[\\/]/).pop())}  ${C.dim((popupStat.size / 1024).toFixed(1) + ' KB')}`);
  console.log(`  Время:   ${C.dim(new Date().toLocaleString())}`);
  console.log('');
  console.log(C.yellow('▼ Что дальше:'));
  console.log('  1. chrome://extensions/ → Remove HiVietBro → Load unpacked');
  console.log('     → ' + C.cyan(join(EXT_ROOT, 'build', 'chrome-mv3-dev')));
  console.log('  2. Закрой все вкладки chat.zalo.me и открой свежую');
  console.log('  3. F12 → Console → должно увидеть: ' + C.cyan(`[zalo-bridge] active v${version}`));
  console.log('     Если в Console другая версия — Chrome закэшировал, ' + C.red('повтори load unpacked'));
  console.log('');
  console.log(C.dim('  Trash-папки старых билдов можно удалить вручную:'));
  console.log(C.dim(`  Remove-Item -Recurse -Force ${EXT_ROOT}/*.trash-*`));
  console.log('');
}

// ===== Run =================================================================

try {
  nukeCaches();
  const newVersion = bumpPatchVersion();
  runPlasmoBuild();
  copyProdToDev();
  const bundle = findBundleFile();
  regressionCanary(bundle);
  printSummary(bundle, newVersion);
} catch (e) {
  fail(e.message ?? String(e));
}
