# Mindo Forum Authentication Integration Guide

This document describes how to integrate Mindo account login with a website forum system. The forum acts as the identity provider, issuing JWT tokens that Mindo uses for authentication and Supabase database access.

## Architecture Overview

Mindo uses a **forum-centric authentication model** where:
- The forum is the sole identity provider (no Supabase Auth/GoTrue)
- Users register on the forum website
- Users sign in to Mindo using forum credentials
- Forum issues a JWT signed with `SUPABASE_JWT_SECRET`
- JWT serves as both auth token and Supabase access token
- Mindo injects JWT into Supabase queries for RLS-protected data

### Key Components

1. **Forum API** (`https://pnksounds.dev/api/auth/login`)
2. **JWT Token** (signed with Supabase JWT secret)
3. **Mindo Auth Context** (manages session state)
4. **Supabase Client** (custom fetch wrapper for JWT injection)
5. **Secure Storage** (persists JWT + user data)

## Forum API Requirements

Your forum must implement a login endpoint that:

### Endpoint
```
POST https://your-forum-domain.com/api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "user_password"
}
```

### Success Response (200 OK)
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid-string",
    "username": "forum_username",
    "email": "user@example.com",
    "customId": "custom_identifier",
    "isStaff": false,
    "isAdmin": false,
    "bio": "User bio text",
    "avatar": "data:image/png;base64,..."
  }
}
```

### Error Responses
- **401 Unauthorized**: Invalid email/password
  ```json
  {
    "error": "Invalid email or password"
  }
  ```
- **403 Forbidden**: Account banned/suspended
- **500 Server Error**: Internal server error

### JWT Token Requirements

The JWT token MUST be signed with your `SUPABASE_JWT_SECRET` and include these claims:

```json
{
  "sub": "user_uuid",           // User ID (required for Supabase RLS)
  "role": "authenticated",      // Required for Supabase RLS
  "email": "user@example.com",   // User email
  "exp": 1234567890,             // Expiration timestamp (Unix seconds)
  "iat": 1234567890              // Issued at timestamp
}
```

**Critical Requirements:**
- Use `SUPABASE_JWT_SECRET` from your Supabase project settings
- `sub` claim must match the user's UUID in your forum database
- `role` must be `"authenticated"` for Supabase RLS to work
- Set reasonable expiration (e.g., 7-30 days)
- Use HS256 algorithm (HMAC with SHA-256)

## Mindo Client Implementation

### 1. Environment Configuration

Add these to your Mindo `.env` file:

```bash
# Supabase Configuration
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here

# Forum Configuration
FORUM_API_URL=https://your-forum-domain.com
FORUM_PASSWORD_RESET_URL=https://your-forum-domain.com/reset.html
```

**Security Notes:**
- `VITE_SUPABASE_ANON_KEY` is safe for client-side (public key)
- Never expose `SUPABASE_JWT_SECRET` or `SUPABASE_SERVICE_ROLE_KEY` in frontend
- Forum API endpoint must be accessible from Mindo client

### 2. Forum Authentication Client

Create `src/lib/forumAuth.ts`:

```typescript
/**
 * Forum authentication client.
 *
 * The forum is the identity provider for Mindo. Users register
 * on the forum website, and sign in to Mindo with those same credentials.
 *
 * The forum issues a JWT signed with SUPABASE_JWT_SECRET, so it doubles as a
 * Supabase access token for RLS-protected queries (PostgREST). Supabase Auth
 * (GoTrue) is NOT used — the forum is the sole auth source.
 */

import { secureGet, secureSet, secureRemove } from './secureStorage'

// ── Config ───────────────────────────────────────────────────────────────────

const FORUM_API_URL = import.meta.env.VITE_FORUM_API_URL || 'https://your-forum-domain.com'
export const FORUM_PASSWORD_RESET_URL = import.meta.env.VITE_FORUM_PASSWORD_RESET_URL || 'https://your-forum-domain.com/reset.html'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ForumUser {
  id: string
  username: string
  email: string
  customId: string
  isStaff: boolean
  isAdmin: boolean
  bio: string
  avatar: string // base64 data URL, may be empty
}

interface ForumLoginResponse {
  token: string
  user: ForumUser
}

interface StoredForumAuth {
  token: string
  user: ForumUser
  storedAt: number
}

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'mindo:forumAuth'

// In-memory cache for synchronous access
let cachedForumAuth: StoredForumAuth | null = null

/** Load forum auth from secure storage into the in-memory cache. */
export async function initSecureForumAuth(): Promise<void> {
  const raw = await secureGet(STORAGE_KEY)
  if (raw) {
    try {
      cachedForumAuth = JSON.parse(raw) as StoredForumAuth
    } catch {
      cachedForumAuth = null
    }
  }
}

export async function storeForumAuth(token: string, user: ForumUser): Promise<void> {
  const data: StoredForumAuth = { token, user, storedAt: Date.now() }
  cachedForumAuth = data
  await secureSet(STORAGE_KEY, JSON.stringify(data))
}

export function getStoredForumAuth(): StoredForumAuth | null {
  return cachedForumAuth
}

export async function clearForumAuth(): Promise<void> {
  cachedForumAuth = null
  await secureRemove(STORAGE_KEY)
}

// ── JWT helpers ────────────────────────────────────────────────────────────────

/** Decode the `exp` claim from a JWT without verifying the signature. */
export function getJwtExp(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/** Check if a JWT is expired (with a 30s clock skew buffer). */
export function isJwtExpired(token: string): boolean {
  const exp = getJwtExp(token)
  if (!exp) return true
  const now = Math.floor(Date.now() / 1000)
  return exp <= now + 30
}

// ── API ─────────────────────────────────────────────────────────────────────────

export async function forumLogin(email: string, password: string): Promise<ForumLoginResponse> {
  let res: Response
  try {
    res = await fetch(`${FORUM_API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    throw new Error('Unable to reach the forum server. Check your internet connection and try again.')
  }

  if (!res.ok) {
    let message = `Login failed (${res.status})`
    try {
      const data = await res.json()
      if (data.error || data.message) message = data.error || data.message
    } catch {
      if (res.statusText) message = `${message}: ${res.statusText}`
    }
    if (res.status === 401 || res.status === 403) {
      message = 'Invalid email or password. Make sure you are using your forum credentials.'
    }
    throw new Error(message)
  }

  const data = (await res.json()) as ForumLoginResponse
  if (!data.token || !data.user?.id) {
    throw new Error('The forum returned an unexpected response. Please try again.')
  }
  return data
}

// ── Convenience ──────────────────────────────────────────────────────────────────

export function restoreForumAuthIfValid(): StoredForumAuth | null {
  const stored = getStoredForumAuth()
  if (!stored) return null
  if (isJwtExpired(stored.token)) {
    console.log('[forumAuth] stored JWT is expired, clearing')
    clearForumAuth().catch(() => {})
    return null
  }
  return stored
}
```

### 3. Secure Storage Implementation

Create `src/lib/secureStorage.ts`:

```typescript
/**
 * Secure storage abstraction for sensitive data (JWT tokens, API keys).
 *
 * Desktop (Electron): Uses Electron's safeStorage API (OS keychain)
 * Web/Android: Uses localStorage with a migration path for future secure storage
 */

const STORAGE_PREFIX = 'mindo:secure:'

// Desktop: Use Electron's safeStorage via IPC
let isDesktop = typeof window !== 'undefined' && !!(window as any).api?.safeStorageGet

export async function secureGet(key: string): Promise<string | null> {
  const fullKey = `${STORAGE_PREFIX}${key}`
  
  if (isDesktop) {
    try {
      return await (window as any).api.safeStorageGet(fullKey)
    } catch {
      return null
    }
  }
  
  // Web/Android fallback
  return localStorage.getItem(fullKey)
}

export async function secureSet(key: string, value: string): Promise<void> {
  const fullKey = `${STORAGE_PREFIX}${key}`
  
  if (isDesktop) {
    try {
      await (window as any).api.safeStorageSet(fullKey, value)
      return
    } catch {
      // Fall through to localStorage
    }
  }
  
  localStorage.setItem(fullKey, value)
}

export async function secureRemove(key: string): Promise<void> {
  const fullKey = `${STORAGE_PREFIX}${key}`
  
  if (isDesktop) {
    try {
      await (window as any).api.safeStorageRemove(fullKey)
      return
    } catch {
      // Fall through to localStorage
    }
  }
  
  localStorage.removeItem(fullKey)
}

/** Migrate data from old localStorage keys to secure storage */
export async function migrateToSecureStorage(key: string): Promise<void> {
  const oldKey = key
  const newKey = `${STORAGE_PREFIX}${key}`
  
  // Check if already migrated
  const existing = await secureGet(key)
  if (existing) return
  
  // Check for old data
  const oldData = localStorage.getItem(oldKey)
  if (oldData) {
    await secureSet(key, oldData)
    localStorage.removeItem(oldKey)
  }
}
```

### 4. Supabase Client with JWT Injection

Create `src/lib/supabase.ts`:

```typescript
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(url && !url.includes('your-project'))
export const isWebGuestMode = !isSupabaseConfigured

// ── JWT injection ──────────────────────────────────────────────────────────────
// We bypass GoTrue entirely. The forum JWT is injected as the Authorization header
// via a custom fetch wrapper for RLS-protected queries.

let currentJwt: string | null = null

const supabaseFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (currentJwt && init) {
    const headers = new Headers(init.headers)
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${currentJwt}`)
    }
    init.headers = headers
  }
  return fetch(input, init)
}

export const supabase = createClient(url || 'https://placeholder.supabase.co', key || 'placeholder', {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
  global: {
    fetch: supabaseFetch,
  },
})

export function setSupabaseSessionFromJwt(token: string): Promise<void> {
  currentJwt = token
  return Promise.resolve()
}

export function clearSupabaseSession(): Promise<void> {
  currentJwt = null
  return Promise.resolve()
}
```

### 5. Auth Context Implementation

Create `src/context/AuthContext.tsx`:

```typescript
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { isWebGuestMode, setSupabaseSessionFromJwt, clearSupabaseSession } from '../lib/supabase'
import {
  forumLogin,
  storeForumAuth,
  clearForumAuth,
  restoreForumAuthIfValid,
  type ForumUser,
} from '../lib/forumAuth'

interface AuthContextType {
  user: ForumUser | null
  isLoading: boolean
  isAuthenticated: boolean
  isGuest: boolean
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>
  signInAsGuest: () => void
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ForumUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isGuest, setIsGuest] = useState(() => localStorage.getItem('mindo:guest') === 'true')

  // Restore session on mount
  useEffect(() => {
    if (isWebGuestMode) {
      setIsLoading(false)
      return
    }

    const stored = restoreForumAuthIfValid()
    if (stored) {
      setUser(stored.user)
      setSupabaseSessionFromJwt(stored.token).catch((err) => {
        console.warn('[AuthContext] failed to set Supabase session on restore:', err)
      })
    } else {
      clearSupabaseSession().catch(() => {})
    }
    setIsLoading(false)
  }, [])

  const signIn = async (email: string, password: string) => {
    try {
      const { token, user: forumUser } = await forumLogin(email, password)
      await storeForumAuth(token, forumUser)
      await setSupabaseSessionFromJwt(token)
      setUser(forumUser)
      if (isGuest) {
        localStorage.removeItem('mindo:guest')
        setIsGuest(false)
      }
      return { error: null }
    } catch (err) {
      console.error('[AuthContext] signIn error:', err)
      return { error: err instanceof Error ? err : new Error('An unexpected error occurred.') }
    }
  }

  const signInAsGuest = () => {
    localStorage.setItem('mindo:guest', 'true')
    setIsGuest(true)
    setIsLoading(false)
  }

  const signOut = async () => {
    localStorage.removeItem('mindo:guest')
    setIsGuest(false)
    clearForumAuth().catch(() => {})
    setUser(null)
    await clearSupabaseSession()
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user || isGuest,
        isGuest,
        signIn,
        signInAsGuest,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
```

### 6. Auth UI Component

Create `src/pages/Auth.tsx`:

```typescript
import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { isWebGuestMode } from '../lib/supabase'
import { FORUM_PASSWORD_RESET_URL } from '../lib/forumAuth'

export default function Auth({ onAuthenticated }: { onAuthenticated?: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { signIn, signInAsGuest } = useAuth()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error } = await signIn(email, password)
      if (error) {
        setError(error.message)
      } else {
        onAuthenticated?.()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.')
    }

    setLoading(false)
  }

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow">
        <h1 className="text-2xl font-bold mb-4">Sign In</h1>
        <p className="text-sm text-gray-600 mb-6">
          Sign in with your forum account
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isWebGuestMode}
              className="w-full p-2 border rounded"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isWebGuestMode}
              className="w-full p-2 border rounded"
              required
            />
            <a
              href={FORUM_PASSWORD_RESET_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline"
            >
              Forgot password?
            </a>
          </div>

          {error && (
            <div className="p-2 bg-red-50 text-red-700 text-sm rounded">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || isWebGuestMode}
            className="w-full p-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => signInAsGuest()}
            className="text-sm text-gray-600 hover:text-gray-800"
          >
            Continue as Guest
          </button>
        </div>

        <p className="mt-4 text-xs text-gray-500 text-center">
          Don't have an account? <a href="https://your-forum-domain.com/register" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Register on the forum</a>
        </p>
      </div>
    </div>
  )
}
```

## Forum Backend Implementation

### JWT Generation (Node.js Example)

Your forum backend needs to generate JWTs signed with Supabase JWT secret:

```javascript
const jwt = require('jsonwebtoken');
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

function generateForumToken(user) {
  const payload = {
    sub: user.id,                    // User UUID
    role: 'authenticated',           // Required for Supabase RLS
    email: user.email,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days
    iat: Math.floor(Date.now() / 1000)
  };

  return jwt.sign(payload, SUPABASE_JWT_SECRET, {
    algorithm: 'HS256'
  });
}

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  // 1. Validate credentials against your forum database
  const user = await validateForumUser(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  
  // 2. Generate JWT signed with Supabase secret
  const token = generateForumToken(user);
  
  // 3. Return token + user data
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      customId: user.customId,
      isStaff: user.isStaff,
      isAdmin: user.isAdmin,
      bio: user.bio,
      avatar: user.avatar
    }
  });
});
```

### User Database Requirements

Your forum user table should include:

```sql
CREATE TABLE forum_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  custom_id TEXT UNIQUE,
  is_staff BOOLEAN DEFAULT FALSE,
  is_admin BOOLEAN DEFAULT FALSE,
  bio TEXT,
  avatar TEXT, -- base64 data URL
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Critical:** The `id` field MUST be a UUID that matches the `sub` claim in the JWT.

## Supabase Configuration

### 1. Get JWT Secret

1. Go to Supabase Dashboard → Your Project → Settings → API
2. Copy the `JWT Secret` (NOT the anon key)
3. Add this to your forum backend environment variables: `SUPABASE_JWT_SECRET`

### 2. Configure RLS Policies

Your Supabase tables should use RLS policies that reference `auth.uid()`:

```sql
-- Enable RLS
ALTER TABLE your_table ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY "Users can view own data"
ON your_table FOR SELECT
USING (auth.uid()::text = user_id);

-- Policy: Users can insert their own data
CREATE POLICY "Users can insert own data"
ON your_table FOR INSERT
WITH CHECK (auth.uid()::text = user_id);

-- Policy: Users can update their own data
CREATE POLICY "Users can update own data"
ON your_table FOR UPDATE
USING (auth.uid()::text = user_id);
```

**Important:** Since we're bypassing GoTrue, `auth.uid()` will return the `sub` claim from the forum JWT.

## Backend API Authentication (Optional)

If you have backend APIs (Azure Functions, Cloudflare Workers) that need to verify forum JWTs:

### Azure Functions Example

```typescript
// mindo-api/src/shared/auth.ts
import { jwtVerify, type JWTPayload } from 'jose'

let cachedSecret: Uint8Array | null = null

function getSecret(): Uint8Array {
  const envSecret = process.env.SUPABASE_JWT_SECRET || ''
  if (cachedSecret) return cachedSecret
  cachedSecret = new TextEncoder().encode(envSecret)
  return cachedSecret
}

export interface AuthenticatedUser {
  userId: string
  role: string
  exp: number
}

export async function verifyAuth(authHeader: string | undefined | null): Promise<AuthenticatedUser> {
  if (!authHeader) {
    throw new Error('UNAUTHORIZED: Missing Authorization header')
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    throw new Error('UNAUTHORIZED: Malformed Authorization header')
  }
  const token = match[1]

  const secret = getSecret()
  if (!process.env.SUPABASE_JWT_SECRET) {
    throw new Error('SERVER_ERROR: SUPABASE_JWT_SECRET is not configured')
  }

  try {
    const result = await jwtVerify(token, secret)
    const payload = result.payload
    
    return {
      userId: payload.sub as string,
      role: (payload.role as string) || 'authenticated',
      exp: payload.exp || 0,
    }
  } catch (err) {
    throw new Error('UNAUTHORIZED: Invalid JWT')
  }
}
```

Usage in Azure Function:

```typescript
import { verifyAuth } from '../shared/auth'

export default async function (req: HttpRequest, context: InvocationContext) {
  try {
    const authUser = await verifyAuth(req.headers.get('Authorization'))
    // Use authUser.userId for per-user logic
    return { json: { userId: authUser.userId } }
  } catch (err) {
    return { 
      status: 401, 
      json: { error: 'Unauthorized' } 
    }
  }
}
```

## Testing Checklist

### Forum API Testing
- [ ] Login endpoint returns valid JWT with correct claims
- [ ] JWT signature verifies with `SUPABASE_JWT_SECRET`
- [ ] JWT `sub` claim matches user UUID
- [ ] JWT `role` claim is `"authenticated"`
- [ ] JWT expiration is set correctly
- [ ] Error responses return proper status codes and messages

### Mindo Client Testing
- [ ] Login with valid credentials succeeds
- [ ] Invalid credentials show user-friendly error
- [ ] JWT is stored securely after login
- [ ] Session persists across app restarts
- [ ] Expired JWT clears and forces re-login
- [ ] Sign out clears all auth data
- [ ] Guest mode works when forum is unavailable
- [ ] Supabase queries include Authorization header
- [ ] RLS policies respect `auth.uid()` from forum JWT

### Integration Testing
- [ ] Forum user can sign in to Mindo
- [ ] Mindo can query Supabase with forum JWT
- [ ] RLS policies restrict data to correct user
- [ ] Backend APIs can verify forum JWTs
- [ ] Token refresh works (if implemented)
- [ ] Password reset flow works end-to-end

## Security Considerations

### Critical Security Requirements
1. **Never expose `SUPABASE_JWT_SECRET` in frontend code** - it's backend-only
2. **Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code** - it's backend-only
3. **Always use HTTPS** for forum API and Supabase calls
4. **Validate and sanitize** all forum API inputs
5. **Rate limit** the forum login endpoint to prevent brute force
6. **Hash passwords** using bcrypt/argon2 in forum database
7. **Set reasonable JWT expiration** (7-30 days recommended)
8. **Implement token refresh** if longer sessions are needed

### Optional Security Enhancements
- Add IP-based rate limiting to forum login
- Implement device fingerprinting for anomaly detection
- Add email verification for new forum registrations
- Implement 2FA for forum accounts
- Add audit logging for sensitive operations
- Implement token revocation for compromised accounts

## Troubleshooting

### Common Issues

**Issue:** "Invalid JWT signature" in Supabase queries
- **Cause:** Forum JWT not signed with correct `SUPABASE_JWT_SECRET`
- **Fix:** Verify forum backend uses the exact JWT secret from Supabase Dashboard

**Issue:** RLS policies not working
- **Cause:** JWT missing `role: "authenticated"` claim
- **Fix:** Ensure forum JWT includes `role: "authenticated"` claim

**Issue:** `auth.uid()` returns null in RLS policies
- **Cause:** JWT `sub` claim doesn't match user UUID format
- **Fix:** Ensure forum user IDs are UUIDs and match `sub` claim

**Issue:** Login works but session doesn't persist
- **Cause:** Secure storage not working on platform
- **Fix:** Verify platform-specific secure storage implementation

**Issue:** "Unable to reach forum server" error
- **Cause:** CORS issues or network connectivity
- **Fix:** Configure CORS on forum backend to allow Mindo origin

## Migration from Existing Auth

If migrating from Supabase Auth to forum-based auth:

1. **Export existing users** from Supabase Auth
2. **Import users** to forum database with same UUIDs
3. **Update forum JWT generation** to use existing UUIDs as `sub` claim
4. **Deploy new Mindo client** with forum auth
5. **Update RLS policies** to work with forum JWTs
6. **Disable Supabase Auth** (optional, can keep as backup)

## Support and Maintenance

### Regular Maintenance Tasks
- Monitor forum API error rates and response times
- Review JWT expiration patterns and adjust if needed
- Audit RLS policies for security gaps
- Test backup/restore procedures for forum database
- Keep dependencies updated (JWT libraries, etc.)

### Monitoring
- Track login success/failure rates
- Monitor JWT validation failures
- Alert on unusual authentication patterns
- Track API response times for forum endpoints

---

**Last Updated:** 2025-01-06
**Mindo Version:** Current
**Forum API Version:** 1.0
