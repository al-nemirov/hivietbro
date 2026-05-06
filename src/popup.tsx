import { useEffect, useState } from 'react';
import { getUser, isEnabled, setEnabled, clearAuth, type StoredUser } from './lib/storage';
import { getUsage } from './lib/api';
import { DASHBOARD_URL } from './lib/config';

interface Usage {
  messages: number;
  chars: number;
  cost_usd: number;
}

function Popup() {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [enabled, setEnabledState] = useState(true);
  const [usage, setUsageState] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [u, e] = await Promise.all([getUser(), isEnabled()]);
      setUser(u);
      setEnabledState(e);
      if (u) {
        try {
          const data = await getUsage();
          setUsageState(data.today);
        } catch {
          // ignore
        }
      }
      setLoading(false);
    })();
  }, []);

  const onToggle = async (): Promise<void> => {
    const next = !enabled;
    setEnabledState(next);
    await setEnabled(next);
  };

  const onLogout = async (): Promise<void> => {
    await clearAuth();
    setUser(null);
  };

  const onLogin = (): void => {
    chrome.runtime.sendMessage({ type: 'login' });
  };

  if (loading) return <div style={{ padding: 16, width: 280 }}>Загрузка…</div>;

  if (!user) {
    return (
      <div style={{ padding: 16, width: 280, fontFamily: 'system-ui' }}>
        <h3 style={{ margin: '0 0 12px' }}>Zalo Bridge</h3>
        <p style={{ fontSize: 13, color: '#555', margin: '0 0 16px' }}>
          Перевод чата Zalo в реальном времени. Войди через Google, чтобы начать.
        </p>
        <button onClick={onLogin} style={btnPrimary}>Войти через Google</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, width: 280, fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        {user.picture_url && <img src={user.picture_url} width={32} height={32} style={{ borderRadius: 16 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user.display_name || user.email}
          </div>
          <div style={{ fontSize: 11, color: '#888' }}>
            {user.is_admin ? 'admin · unlimited' : `${user.plan} plan`}
          </div>
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 14 }}>
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        Перевод включён
      </label>

      {usage && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 12, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
          <div>Сегодня: {usage.messages} сообщений</div>
          {!user.is_admin && <div>Расход: ${usage.cost_usd.toFixed(4)}</div>}
        </div>
      )}

      <a href={`${DASHBOARD_URL}/account`} target="_blank" style={linkStyle}>Личный кабинет</a>
      <a href={`${DASHBOARD_URL}/glossary`} target="_blank" style={linkStyle}>Глоссарий</a>
      <button onClick={onLogout} style={btnSecondary}>Выйти</button>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  background: '#4082ff',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
};

const btnSecondary: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  marginTop: 8,
  background: '#f5f5f5',
  color: '#333',
  border: '1px solid #ddd',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};

const linkStyle: React.CSSProperties = {
  display: 'block',
  padding: '6px 0',
  fontSize: 13,
  color: '#4082ff',
  textDecoration: 'none',
};

export default Popup;
