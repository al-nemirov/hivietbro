// API endpoint меняется через .env.development / .env.production у Plasmo
// PLASMO_PUBLIC_* переменные пробрасываются в client-side код
export const API_BASE =
  process.env.PLASMO_PUBLIC_API_BASE ?? 'https://zalo-bridge-api.aleuphoria.workers.dev';

export const DASHBOARD_URL =
  process.env.PLASMO_PUBLIC_DASHBOARD_URL ?? 'https://hivietbro.com';

// Storage keys
export const STORAGE = {
  token: 'zb_token',
  user: 'zb_user',
  enabled: 'zb_enabled',
  preferredLang: 'zb_preferred_lang',
  partnerLang: 'zb_partner_lang',
} as const;
