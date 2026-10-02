export interface AuthUser { id: string; name: string; email?: string; guest: boolean; }
export interface AuthResult { accessToken: string; user: AuthUser; expiresIn?: number; }

function readCookie(name: string): string {
  const prefix = `${name}=`;
  return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? '';
}

export class AuthService {
  token = sessionStorage.getItem('dargaze.access') ?? '';
  user: AuthUser | null = null;

  private save(result: AuthResult): AuthResult {
    this.token = result.accessToken; this.user = result.user;
    sessionStorage.setItem('dargaze.access', this.token);
    return result;
  }

  private async request<T>(path: string, body?: unknown, options: { method?: string; csrf?: boolean } = {}): Promise<T> {
    const method = options.method ?? 'POST';
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.csrf) headers['X-CSRF-Token'] = decodeURIComponent(readCookie('dargaze_csrf'));
    const response = await fetch(path, {
      method, headers, credentials: 'include',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
    if (!response.ok) throw new Error(data.error ?? data.message ?? `Request failed (${response.status})`);
    return data;
  }

  async restore(): Promise<AuthUser | null> {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const googleToken = hash.get('access');
    if (googleToken) {
      this.token = googleToken; sessionStorage.setItem('dargaze.access', googleToken);
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
    }
    if (this.token) {
      try {
        const data = await this.request<{ user: AuthUser }>('/api/auth/me', undefined, { method: 'GET' });
        this.user = data.user; return this.user;
      } catch { this.token = ''; sessionStorage.removeItem('dargaze.access'); }
    }
    try {
      const data = await this.request<AuthResult>('/api/auth/refresh', undefined, { method: 'POST', csrf: true });
      this.save(data); return data.user;
    } catch { return null; }
  }

  async guest(name = 'Wanderer'): Promise<AuthResult> {
    const result = await this.request<AuthResult>('/api/auth/guest', { name });
    return this.save(result);
  }

  async login(email: string, password: string, totpCode?: string, captchaToken?: string): Promise<AuthResult> {
    const result = await this.request<AuthResult>('/api/auth/login', { email, password, ...(totpCode ? { totpCode } : {}), ...(captchaToken ? { captchaToken } : {}) });
    return this.save(result);
  }

  async register(email: string, password: string, name: string, captchaToken?: string): Promise<{ message: string }> {
    return this.request('/api/auth/register', { email, password, name, ...(captchaToken ? { captchaToken } : {}) });
  }

  async logout(): Promise<void> {
    try { await this.request('/api/auth/logout', {}, { csrf: true }); } catch { /* local sign-out still succeeds */ }
    this.token = ''; this.user = null; sessionStorage.removeItem('dargaze.access');
  }

  async refresh(): Promise<boolean> {
    try { const data = await this.request<AuthResult>('/api/auth/refresh', undefined, { method: 'POST', csrf: true }); this.save(data); return true; }
    catch { return false; }
  }

  clear(): void { this.token = ''; this.user = null; sessionStorage.removeItem('dargaze.access'); }
}
