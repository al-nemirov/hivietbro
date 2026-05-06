// Plasmo content script — инжектится в chat.zalo.me
// Селекторы разведаны 2026-05-06, см. docs/zalo-dom.md

import type { PlasmoCSConfig } from 'plasmo';
import { translate as apiTranslate } from '../lib/api';
import { getToken, isEnabled } from '../lib/storage';
import { cacheGet, cacheSet } from '../lib/cache';
import {
  getOrInitChatSettings,
  setChatSettings,
  SUPPORTED_PARTNER_LANGS,
  type ChatSettings,
} from '../lib/chat-settings';

export const config: PlasmoCSConfig = {
  matches: ['https://chat.zalo.me/*'],
  all_frames: false,
  run_at: 'document_idle',
};

// === SELECTORS ==============================================================
const SEL = {
  messageContainer: '#messageViewScroll',
  messageBubble: '[data-component="bubble-message"]',
  messageText: '[data-component="message-text-content"]',
  inputField: '#richInput',
  sendButton: '.send-msg-btn',
};

const OUTGOING_CLASS = 'me';
const QID_HOST_SELECTOR = '[data-component="message-content-view"]';
// ============================================================================

const OVERLAY_CLASS = 'zb-overlay';
const OVERLAY_DATA_ATTR = 'data-zb-msg-id';
const STATUS_CLASS = 'zb-status';
const CHIP_CLASS = 'zb-chip';

let attachedMsgRoot: Element | null = null;
let msgObserver: MutationObserver | null = null;
let translationInFlight = false;
let outgoingHandlersAttached = false;

let currentChatKey: string | null = null;
let currentChatSettings: ChatSettings | null = null;

const pending = new Map<string, Promise<string>>();

async function bootstrap(): Promise<void> {
  if (!(await isEnabled())) return;
  const token = await getToken();
  if (!token) {
    console.info('[zalo-bridge] не залогинен — открой popup расширения');
    return;
  }

  injectStyles();
  attachOutgoingInterceptors();
  watchUI();
  console.info('[zalo-bridge] active');
}

function injectStyles(): void {
  if (document.getElementById('zb-styles')) return;
  const css = `
    @keyframes zb-fade-in {
      from { opacity: 0; transform: translateY(-2px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes zb-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }
    @keyframes zb-pop {
      from { opacity: 0; transform: translateY(6px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .${OVERLAY_CLASS} {
      display: block;
      margin: 3px 0 0;
      padding: 5px 9px 5px 11px;
      background: transparent;
      border-left: 2px solid #4082ff;
      border-radius: 0 4px 4px 0;
      font-size: 12.5px;
      line-height: 1.45;
      color: #1d4ed8;
      white-space: pre-wrap;
      word-break: break-word;
      animation: zb-fade-in 0.2s ease-out;
      position: relative;
    }
    .${OVERLAY_CLASS}::before {
      content: 'RU';
      position: absolute;
      top: 4px;
      right: 6px;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #94a3b8;
      opacity: 0.6;
      pointer-events: none;
    }
    .${OVERLAY_CLASS}[data-loading="1"] {
      animation: zb-pulse 1.2s ease-in-out infinite;
      color: #94a3b8;
      font-style: italic;
    }
    .${OVERLAY_CLASS}[data-error="1"] {
      border-left-color: #ef4444;
      color: #b91c1c;
      font-size: 11.5px;
    }
    .${OVERLAY_CLASS}[data-error="1"]::before { content: 'ERR'; color: #ef4444; }

    .${STATUS_CLASS} {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translate(-50%, 12px);
      padding: 8px 14px;
      background: rgba(26, 29, 36, 0.92);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: #fff;
      border-radius: 18px;
      font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1);
      z-index: 999998;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.18s ease, transform 0.18s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .${STATUS_CLASS}--show { opacity: 1; transform: translate(-50%, 0); }
    .${STATUS_CLASS}--error { background: rgba(185, 28, 28, 0.95); }
    .${STATUS_CLASS}__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4082ff;
      animation: zb-pulse 1s ease-in-out infinite;
      flex: 0 0 auto;
    }
    .${STATUS_CLASS}--success .${STATUS_CLASS}__dot { background: #10b981; animation: none; }
    .${STATUS_CLASS}--error .${STATUS_CLASS}__dot { background: #fca5a5; animation: none; }

    /* Floating chip — управление переводом для текущего чата */
    .${CHIP_CLASS} {
      position: fixed;
      right: 20px;
      bottom: 100px;
      z-index: 999997;
      font: 500 12.5px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: zb-pop 0.18s ease-out;
    }
    .${CHIP_CLASS}__btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      background: #fff;
      border: 1px solid #e6e8ec;
      border-radius: 22px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05);
      cursor: pointer;
      color: #1a1d24;
      transition: all 0.15s ease;
      font: inherit;
    }
    .${CHIP_CLASS}__btn:hover { border-color: #4082ff; box-shadow: 0 4px 20px rgba(64, 130, 255, 0.18); }
    .${CHIP_CLASS}__dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #cbd5e1;
      flex: 0 0 auto;
    }
    .${CHIP_CLASS}--on .${CHIP_CLASS}__dot { background: #10b981; }
    .${CHIP_CLASS}--on .${CHIP_CLASS}__btn { border-color: #d1ddf4; background: #f7faff; }
    .${CHIP_CLASS}__lang { font-weight: 700; letter-spacing: 0.3px; color: #4082ff; }
    .${CHIP_CLASS}--off .${CHIP_CLASS}__lang { color: #94a3b8; }

    .${CHIP_CLASS}__menu {
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      width: 240px;
      background: #fff;
      border: 1px solid #e6e8ec;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04);
      padding: 10px;
      animation: zb-pop 0.15s ease-out;
    }
    .${CHIP_CLASS}__menu-header {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #94a3b8;
      padding: 4px 6px 6px;
    }
    .${CHIP_CLASS}__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 6px;
      cursor: pointer;
      border-radius: 6px;
    }
    .${CHIP_CLASS}__row:hover { background: #f8fafc; }
    .${CHIP_CLASS}__row strong { color: #1a1d24; font-weight: 500; }
    .${CHIP_CLASS}__chat-name {
      font-size: 11px;
      color: #94a3b8;
      padding: 0 6px 6px;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${CHIP_CLASS}__divider { height: 1px; background: #f0f2f5; margin: 6px -10px; }
    .${CHIP_CLASS}__lang-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 6px;
      cursor: pointer;
      border-radius: 6px;
      color: #1a1d24;
    }
    .${CHIP_CLASS}__lang-row:hover { background: #f8fafc; }
    .${CHIP_CLASS}__lang-row--active {
      background: #e8f0ff;
      color: #1d4ed8;
      font-weight: 600;
    }
    .${CHIP_CLASS}__lang-row--active:hover { background: #dde8ff; }
    .${CHIP_CLASS}__lang-tag {
      flex: 0 0 28px;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.4px;
      color: #4082ff;
      padding: 3px 0;
      text-align: center;
      border: 1px solid #d1ddf4;
      background: #f0f7ff;
      border-radius: 4px;
    }

    .${CHIP_CLASS}__switch {
      position: relative;
      width: 36px;
      height: 20px;
      background: #cbd5e1;
      border-radius: 10px;
      border: 0;
      padding: 0;
      cursor: pointer;
      transition: background 0.15s ease;
      flex: 0 0 auto;
    }
    .${CHIP_CLASS}__switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: left 0.15s ease;
    }
    .${CHIP_CLASS}__switch[data-on="1"] { background: #10b981; }
    .${CHIP_CLASS}__switch[data-on="1"]::after { left: 18px; }
  `;
  const style = document.createElement('style');
  style.id = 'zb-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// ===== INCOMING (read) ======================================================

function isOutgoing(bubble: Element): boolean {
  return bubble.classList.contains(OUTGOING_CLASS);
}

function getBubbleStableId(bubble: Element): string | null {
  const qid = bubble.querySelector(QID_HOST_SELECTOR)?.getAttribute('data-qid');
  if (qid) return qid;
  return bubble.id || null;
}

function extractText(bubble: Element): string {
  const t = bubble.querySelector(SEL.messageText);
  return (t?.textContent ?? '').trim();
}

function getChatKey(): string | null {
  const input = document.querySelector(SEL.inputField) as HTMLElement | null;
  return input?.dataset?.trailer || null;
}

async function loadCurrentChatSettings(force = false): Promise<void> {
  const k = getChatKey();
  if (!k) {
    currentChatKey = null;
    currentChatSettings = null;
    return;
  }
  if (!force && k === currentChatKey && currentChatSettings) return;
  currentChatKey = k;
  currentChatSettings = await getOrInitChatSettings(k, k);
}

async function processBubble(bubble: Element): Promise<void> {
  if (isOutgoing(bubble)) return;
  if (bubble.querySelector(`[${OVERLAY_DATA_ATTR}]`)) return;
  if (!currentChatSettings || !currentChatSettings.enabled) return;

  const qid = getBubbleStableId(bubble);
  if (!qid) return;

  const text = extractText(bubble);
  if (!text) return;

  const srcLang = currentChatSettings.partner_lang;
  const tgtLang = currentChatSettings.preferred_lang;

  const target = bubble.querySelector('.message-content-wrapper') ?? bubble;
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.dataset.loading = '1';
  overlay.setAttribute(OVERLAY_DATA_ATTR, qid);
  overlay.textContent = '…';
  target.appendChild(overlay);

  try {
    const cached = await cacheGet(qid, srcLang, tgtLang);
    if (cached && cached.src_text === text) {
      overlay.textContent = cached.tgt_text;
      overlay.dataset.loading = '0';
      return;
    }

    let translation: string;
    const pendKey = `${qid}|${srcLang}|${tgtLang}`;
    if (pending.has(pendKey)) {
      translation = await pending.get(pendKey)!;
    } else {
      const p = (async () => {
        const result = await apiTranslate({
          text,
          source_lang: srcLang,
          target_lang: tgtLang,
          direction: 'incoming',
          chat_id: currentChatKey ?? undefined,
        });
        await cacheSet(qid, {
          src_text: text,
          src_lang: srcLang,
          tgt_text: result.translation,
          tgt_lang: tgtLang,
          ts: Date.now(),
        });
        return result.translation;
      })();
      pending.set(pendKey, p);
      try {
        translation = await p;
      } finally {
        pending.delete(pendKey);
      }
    }

    overlay.textContent = translation;
    overlay.dataset.loading = '0';
  } catch (err) {
    overlay.dataset.error = '1';
    overlay.dataset.loading = '0';
    overlay.textContent = `[ошибка: ${(err as Error).message}]`;
  }
}

function rescanVisibleMessages(): void {
  if (!attachedMsgRoot) return;
  if (!currentChatSettings?.enabled) {
    // выключили — сносим все наши overlay'и в этом скролле
    attachedMsgRoot.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
    return;
  }
  attachedMsgRoot.querySelectorAll(SEL.messageBubble).forEach((b) => void processBubble(b));
}

function attachMessageObserver(root: Element): void {
  if (attachedMsgRoot === root) return;
  if (msgObserver) {
    msgObserver.disconnect();
    msgObserver = null;
  }
  attachedMsgRoot = root;
  rescanVisibleMessages();

  msgObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.matches(SEL.messageBubble)) {
          void processBubble(n);
        } else {
          n.querySelectorAll?.(SEL.messageBubble).forEach((b) => void processBubble(b));
        }
      });
    }
  });
  msgObserver.observe(root, { childList: true, subtree: true });
}

// ===== FLOATING CHIP ========================================================

function ensureChip(): HTMLElement {
  let chip = document.querySelector(`.${CHIP_CLASS}`) as HTMLElement | null;
  if (chip) return chip;
  chip = document.createElement('div');
  chip.className = CHIP_CLASS;
  document.body.appendChild(chip);
  return chip;
}

function renderChip(): void {
  const chip = ensureChip();
  const s = currentChatSettings;

  if (!currentChatKey || !s) {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  chip.classList.toggle(`${CHIP_CLASS}--on`, !!s.enabled);
  chip.classList.toggle(`${CHIP_CLASS}--off`, !s.enabled);

  const langInfo = SUPPORTED_PARTNER_LANGS.find((l) => l.code === s.partner_lang);
  const langTag = langInfo?.flag ?? s.partner_lang.toUpperCase();
  const stateText = s.enabled ? 'перевод вкл' : 'перевод выкл';

  // Не пересоздаём если просто меняется состояние — обновляем содержимое
  if (!chip.querySelector(`.${CHIP_CLASS}__btn`)) {
    chip.innerHTML = `
      <button class="${CHIP_CLASS}__btn" type="button" aria-label="Настройки перевода">
        <span class="${CHIP_CLASS}__dot"></span>
        <span class="${CHIP_CLASS}__lang"></span>
        <span class="${CHIP_CLASS}__state"></span>
      </button>
    `;
    const btn = chip.querySelector(`.${CHIP_CLASS}__btn`) as HTMLElement;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChipMenu(chip);
    });
  }
  const langEl = chip.querySelector(`.${CHIP_CLASS}__lang`);
  const stateEl = chip.querySelector(`.${CHIP_CLASS}__state`);
  if (langEl) langEl.textContent = langTag;
  if (stateEl) stateEl.textContent = stateText;
}

function toggleChipMenu(chip: HTMLElement): void {
  const existing = chip.querySelector(`.${CHIP_CLASS}__menu`);
  if (existing) {
    existing.remove();
    return;
  }

  const s = currentChatSettings;
  if (!s) return;

  const menu = document.createElement('div');
  menu.className = `${CHIP_CLASS}__menu`;

  const langOptions = SUPPORTED_PARTNER_LANGS.map(
    (lang) => `
    <div class="${CHIP_CLASS}__lang-row${lang.code === s.partner_lang ? ` ${CHIP_CLASS}__lang-row--active` : ''}" data-lang="${lang.code}">
      <span class="${CHIP_CLASS}__lang-tag">${lang.flag}</span>
      <span>${lang.label}</span>
    </div>
  `
  ).join('');

  menu.innerHTML = `
    <div class="${CHIP_CLASS}__chat-name">${escapeHtml(currentChatKey ?? '')}</div>
    <div class="${CHIP_CLASS}__row" data-action="toggle">
      <strong>Перевод включён</strong>
      <button class="${CHIP_CLASS}__switch" type="button" data-on="${s.enabled ? '1' : '0'}"></button>
    </div>
    <div class="${CHIP_CLASS}__divider"></div>
    <div class="${CHIP_CLASS}__menu-header">Партнёр говорит на</div>
    ${langOptions}
  `;

  chip.appendChild(menu);

  // Toggle handler
  const toggleRow = menu.querySelector(`[data-action="toggle"]`) as HTMLElement;
  toggleRow.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentChatKey || !currentChatSettings) return;
    currentChatSettings = { ...currentChatSettings, enabled: !currentChatSettings.enabled };
    await setChatSettings(currentChatKey, currentChatSettings);
    const sw = menu.querySelector(`.${CHIP_CLASS}__switch`) as HTMLElement;
    sw.dataset.on = currentChatSettings.enabled ? '1' : '0';
    renderChip();
    rescanVisibleMessages();
  });

  // Lang handlers
  menu.querySelectorAll(`[data-lang]`).forEach((row) => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const lang = (row as HTMLElement).dataset.lang;
      if (!lang || !currentChatKey || !currentChatSettings) return;
      if (lang === currentChatSettings.partner_lang) return;
      currentChatSettings = { ...currentChatSettings, partner_lang: lang };
      await setChatSettings(currentChatKey, currentChatSettings);
      menu.remove();
      renderChip();
      rescanVisibleMessages();
    });
  });

  // close on outside click
  const close = (ev: MouseEvent): void => {
    if (!menu.contains(ev.target as Node) && !chip.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ===== OUTGOING — перехват натуральной отправки ============================

function getStatus(): HTMLElement {
  let el = document.querySelector(`.${STATUS_CLASS}`) as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = STATUS_CLASS;
    el.innerHTML = `<span class="${STATUS_CLASS}__dot"></span><span class="${STATUS_CLASS}__text"></span>`;
    document.body.appendChild(el);
  }
  return el;
}

type StatusVariant = 'progress' | 'success' | 'error';

function showStatus(text: string, variant: StatusVariant = 'progress'): void {
  const el = getStatus();
  const textEl = el.querySelector(`.${STATUS_CLASS}__text`);
  if (textEl) textEl.textContent = text;
  el.classList.toggle(`${STATUS_CLASS}--success`, variant === 'success');
  el.classList.toggle(`${STATUS_CLASS}--error`, variant === 'error');
  el.classList.add(`${STATUS_CLASS}--show`);
}

function hideStatus(): void {
  const el = getStatus();
  el.classList.remove(`${STATUS_CLASS}--show`, `${STATUS_CLASS}--error`, `${STATUS_CLASS}--success`);
}

function attachOutgoingInterceptors(): void {
  if (outgoingHandlersAttached) return;
  outgoingHandlersAttached = true;

  document.addEventListener(
    'keydown',
    (e) => {
      if (translationInFlight) return;
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!currentChatSettings?.enabled) return;
      const input = document.querySelector(SEL.inputField) as HTMLElement | null;
      if (!input) return;
      if (!input.contains(e.target as Node)) return;
      const text = (input.textContent ?? '').trim();
      if (!text) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      void interceptAndSend(input, text);
    },
    true
  );

  document.addEventListener(
    'click',
    (e) => {
      if (translationInFlight) return;
      if (!currentChatSettings?.enabled) return;
      const btn = (e.target as Element)?.closest?.(SEL.sendButton) as HTMLElement | null;
      if (!btn) return;
      const input = document.querySelector(SEL.inputField) as HTMLElement | null;
      if (!input) return;
      const text = (input.textContent ?? '').trim();
      if (!text) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      void interceptAndSend(input, text);
    },
    true
  );
}

async function interceptAndSend(input: HTMLElement, ruText: string): Promise<void> {
  if (translationInFlight) return;
  if (!currentChatSettings) return;
  translationInFlight = true;
  showStatus('Перевожу…');

  try {
    const result = await apiTranslate({
      text: ruText,
      source_lang: currentChatSettings.preferred_lang,
      target_lang: currentChatSettings.partner_lang,
      direction: 'outgoing',
      chat_id: currentChatKey ?? undefined,
    });
    const vi = result.translation;
    if (!vi) throw new Error('пустой перевод');

    input.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, vi);

    await new Promise((r) => setTimeout(r, 80));

    const sendBtn = document.querySelector(SEL.sendButton) as HTMLElement | null;
    if (!sendBtn) throw new Error('кнопка отправки не найдена');
    sendBtn.click();

    showStatus('Отправлено', 'success');
    setTimeout(hideStatus, 1000);
  } catch (err) {
    console.error('[zalo-bridge] send failed:', err);
    showStatus(`Ошибка: ${(err as Error).message}`, 'error');
    setTimeout(hideStatus, 3500);
  } finally {
    translationInFlight = false;
  }
}

// ===== ROOT WATCHER (debounced) ============================================

function watchUI(): void {
  let pendingTick: number | null = null;
  let lastChatKey: string | null = null;

  const tick = async (): Promise<void> => {
    pendingTick = null;
    const msgRoot = document.querySelector(SEL.messageContainer);

    // Если контейнера нет — чат не открыт. Скрываем chip, освобождаем observer.
    if (!msgRoot) {
      if (attachedMsgRoot) {
        attachedMsgRoot = null;
        if (msgObserver) {
          msgObserver.disconnect();
          msgObserver = null;
        }
      }
      currentChatKey = null;
      currentChatSettings = null;
      lastChatKey = null;
      renderChip();
      return;
    }

    const k = getChatKey();
    const chatChanged = k !== lastChatKey;
    if (chatChanged) {
      lastChatKey = k;
      await loadCurrentChatSettings(true);
    }

    if (msgRoot !== attachedMsgRoot) attachMessageObserver(msgRoot);
    renderChip();
  };

  const schedule = (): void => {
    if (pendingTick !== null) return;
    pendingTick = window.setTimeout(() => void tick(), 200);
  };

  void tick();

  // Дебаунсим body-обзёрвер: 200мс достаточно для обнаружения смены чата,
  // но Zalo's микро-мутации не вызывают тысячи tick'ов.
  const bodyObs = new MutationObserver(schedule);
  bodyObs.observe(document.body, { childList: true, subtree: true });
}

bootstrap().catch((e) => console.error('[zalo-bridge] bootstrap failed:', e));
