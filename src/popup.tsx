import { useEffect, useState } from 'react';
import { getUser, isEnabled, setEnabled, clearAuth, type StoredUser } from './lib/storage';
import { getUsage } from './lib/api';
import { cacheClear, cacheStats } from './lib/cache-client';

interface Usage {
  messages: number;
  chars: number;
  cost_usd: number;
}

const C = {
  bg: '#fafbfc',
  card: '#ffffff',
  cardBorder: '#e6e8ec',
  text: '#1a1d24',
  textMuted: '#6b7280',
  textDim: '#9ca3af',
  accent: '#4082ff',
  accentDim: '#e8f0ff',
  accentDark: '#2a5fea',
  success: '#10b981',
  divider: '#f0f2f5',
};

function Popup() {
  const [user, setUserState] = useState<StoredUser | null>(null);
  const [enabled, setEnabledState] = useState(true);
  const [usage, setUsageState] = useState<Usage | null>(null);
  const [cacheCount, setCacheCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);

  const refresh = async (): Promise<void> => {
    const [u, e, stats] = await Promise.all([getUser(), isEnabled(), cacheStats()]);
    setUserState(u);
    setEnabledState(e);
    setCacheCount(stats.count);
    if (u) {
      try {
        const data = await getUsage();
        setUsageState(data.today);
      } catch {
        // ignore
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onToggle = async (): Promise<void> => {
    const next = !enabled;
    setEnabledState(next);
    await setEnabled(next);
  };

  const onLogout = async (): Promise<void> => {
    if (!confirm('Выйти из аккаунта? Локальный кэш переводов будет очищен.')) return;
    await clearAuth();
    await cacheClear();
    setUserState(null);
    setUsageState(null);
    setCacheCount(0);
  };

  const onClearCache = async (): Promise<void> => {
    if (!confirm('Очистить кэш переводов?\nСтарые сообщения будут переводиться заново при открытии чата.')) return;
    await cacheClear();
    setCacheCount(0);
  };

  const onLogin = async (): Promise<void> => {
    setSigningIn(true);
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage({ type: 'login' }, resolve);
      });
      if (!result.ok) {
        alert(`Ошибка входа: ${result.error ?? 'unknown'}`);
        return;
      }
      await refresh();
    } finally {
      setSigningIn(false);
    }
  };

  if (loading) {
    return (
      <div style={shell}>
        <div style={{ ...emptyState, color: C.textMuted }}>Загрузка…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={shell}>
        <div style={brandBlock}>
          <div style={brandIcon}>ZB</div>
          <div>
            <div style={brandName}>Zalo Bridge</div>
            <div style={brandTagline}>Перевод чата в реальном времени</div>
          </div>
        </div>
        <div style={{ ...card, padding: 18, marginTop: 16 }}>
          <p style={{ margin: '0 0 14px', color: C.textMuted, fontSize: 13, lineHeight: 1.5 }}>
            Войди через Google, чтобы расширение могло переводить твои входящие и исходящие сообщения через Claude.
          </p>
          <button onClick={onLogin} style={btnPrimary} disabled={signingIn}>
            {signingIn ? 'Открываю Google…' : 'Войти через Google'}
          </button>
        </div>
        <div style={{ ...footer, marginTop: 12 }}>v0.0.1 · build dev</div>
      </div>
    );
  }

  const planLabel = user.is_admin ? 'admin · безлимит' : user.plan === 'pro' ? 'pro' : user.plan === 'byok' ? 'свой ключ' : 'free';
  const planAccent = user.is_admin ? C.accent : user.plan === 'pro' ? C.success : user.plan === 'byok' ? '#8b5cf6' : C.textMuted;

  const initials = (user.display_name || user.email).slice(0, 1).toUpperCase();

  return (
    <div style={shell}>
      <div style={brandBlock}>
        <div style={brandIcon}>ZB</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={brandName}>Zalo Bridge</div>
          <div style={brandTagline}>{user.partner_lang.toUpperCase()} ↔ {user.preferred_lang.toUpperCase()}</div>
        </div>
      </div>

      <div style={{ ...card, padding: 14, marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {user.picture_url ? (
            <img src={user.picture_url} width={40} height={40} style={{ borderRadius: 20 }} alt="" />
          ) : (
            <div style={avatarFallback}>{initials}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.display_name || user.email.split('@')[0]}
            </div>
            <div style={{ fontSize: 11, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </div>
          </div>
          <div style={{ ...planBadge, color: planAccent, borderColor: planAccent + '40', background: planAccent + '14' }}>
            {planLabel}
          </div>
        </div>
      </div>

      <div style={{ ...card, padding: 14, marginTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>Перевод включён</div>
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>
              {enabled ? 'Сообщения переводятся автоматически' : 'Расширение пассивно'}
            </div>
          </div>
          <Switch checked={enabled} onChange={onToggle} />
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
        <Stat label="Сегодня" value={usage?.messages ?? 0} sub={user.is_admin ? '∞' : `${usage?.cost_usd?.toFixed(4) ?? '0.0000'} $`} />
        <Stat label="Локальный кэш" value={cacheCount} sub="переводов" />
      </div>

      {cacheCount > 0 && (
        <div style={{ marginTop: 6, textAlign: 'right' }}>
          <a onClick={onClearCache} style={subtleLink}>очистить кэш</a>
        </div>
      )}

      <div style={{ marginTop: 14, padding: 12, background: '#f0f7ff', borderRadius: 10, fontSize: 11.5, color: C.textMuted, lineHeight: 1.5 }}>
        Перевод включается <strong style={{ color: C.text }}>в каждом чате отдельно</strong> через банер над сообщениями. По умолчанию все чаты — выключены.
      </div>

      <button onClick={onLogout} style={btnGhost}>Выйти</button>
      <div style={footer}>v0.0.1 · {user.is_admin ? 'admin' : user.plan}</div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub: string }) {
  return (
    <div style={{ ...card, padding: 12 }}>
      <div style={{ fontSize: 10, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: C.text, marginTop: 4, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      style={{
        position: 'relative',
        width: 38,
        height: 22,
        borderRadius: 11,
        background: checked ? C.accent : '#cbd5e1',
        border: 0,
        cursor: 'pointer',
        transition: 'background 0.15s ease',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 18,
          height: 18,
          borderRadius: 9,
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.15s ease',
        }}
      />
    </button>
  );
}

const shell: React.CSSProperties = {
  width: 320,
  padding: 16,
  background: C.bg,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  color: C.text,
  boxSizing: 'border-box',
};

const card: React.CSSProperties = {
  background: C.card,
  border: `1px solid ${C.cardBorder}`,
  borderRadius: 10,
};

const emptyState: React.CSSProperties = {
  padding: 32,
  textAlign: 'center',
  fontSize: 13,
};

const brandBlock: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const brandIcon: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 9,
  background: `linear-gradient(135deg, ${C.accent} 0%, ${C.accentDark} 100%)`,
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: -0.3,
};

const brandName: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: C.text,
  lineHeight: 1.2,
};

const brandTagline: React.CSSProperties = {
  fontSize: 11,
  color: C.textDim,
  marginTop: 2,
};

const avatarFallback: React.CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 20,
  background: `linear-gradient(135deg, ${C.accent} 0%, ${C.accentDark} 100%)`,
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 16,
  fontWeight: 600,
};

const planBadge: React.CSSProperties = {
  flex: '0 0 auto',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.3,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid',
  whiteSpace: 'nowrap',
};

const btnPrimary: React.CSSProperties = {
  width: '100%',
  padding: '11px 14px',
  background: C.accent,
  color: '#fff',
  border: 0,
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 500,
  transition: 'background 0.15s ease',
};

const btnGhost: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  marginTop: 12,
  background: 'transparent',
  color: C.textMuted,
  border: `1px solid ${C.cardBorder}`,
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

const subtleLink: React.CSSProperties = {
  fontSize: 11,
  color: C.textMuted,
  cursor: 'pointer',
  textDecoration: 'underline',
};

const footer: React.CSSProperties = {
  fontSize: 10,
  color: C.textDim,
  textAlign: 'center',
  marginTop: 12,
  letterSpacing: 0.3,
};

export default Popup;
