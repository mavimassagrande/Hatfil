# Guida Implementazione Login Arke per Applicazioni Replit

Questa guida descrive come implementare correttamente l'autenticazione con Arke in un'applicazione Replit (Node.js/Express + React).

---

## 1. Panoramica Architettura

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   React     │────▶│   Express   │────▶│   Arke API  │
│  Frontend   │     │   Backend   │     │  (Backend)  │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │
       │              ┌────┴────┐
       │              │ Session │
       └──────────────│ Cookie  │
                      └─────────┘
```

**Flusso:**
1. Utente inserisce credenziali nel frontend
2. Frontend chiama `POST /api/login` sul backend Express
3. Backend chiama Arke `/login` e riceve JWT token
4. Backend salva token in sessione Express
5. Tutte le richieste successive usano il token dalla sessione

---

## 2. Dipendenze Necessarie

```bash
npm install express express-session memorystore
```

**Package.json:**
```json
{
  "dependencies": {
    "express": "^4.x",
    "express-session": "^1.x",
    "memorystore": "^1.x"
  }
}
```

---

## 3. Configurazione Server Express

### 3.1 Trust Proxy (CRITICO per Replit)

Replit usa un reverse proxy. Senza questa configurazione, i cookie sicuri non funzionano:

```typescript
// server/index.ts
import express from "express";

const app = express();

// CRITICO: Necessario per cookie sicuri dietro reverse proxy Replit
app.set("trust proxy", 1);
```

### 3.2 Session Store

Usare `memorystore` per gestire sessioni in memoria con cleanup automatico:

```typescript
import session from "express-session";
import createMemoryStore from "memorystore";

const MemoryStore = createMemoryStore(session);

app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key",
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({
    checkPeriod: 86400000, // Cleanup ogni 24 ore
  }),
  cookie: {
    secure: process.env.NODE_ENV === "production", // HTTPS in produzione
    httpOnly: true,                                  // Non accessibile da JS
    maxAge: 24 * 60 * 60 * 1000,                    // 24 ore
    sameSite: "lax",                                // Protezione CSRF
  },
}));
```

### 3.3 Dichiarazione Tipo Sessione

Estendere il tipo sessione per TypeScript:

```typescript
// server/types.ts o inline
declare module "express-session" {
  interface SessionData {
    arkeToken?: string;
    user?: {
      username: string;
      full_name: string;
      roles: string[];
    };
  }
}
```

---

## 4. AsyncLocalStorage per Isolamento Token (IMPORTANTE)

Quando più utenti fanno richieste simultanee, ogni richiesta deve usare il proprio token. Usare `AsyncLocalStorage` di Node.js:

### 4.1 Setup AsyncLocalStorage

```typescript
// server/request-context.ts
import { AsyncLocalStorage } from "async_hooks";

interface RequestContext {
  arkeToken: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getArkeToken(): string | null {
  const ctx = requestContext.getStore();
  return ctx?.arkeToken ?? null;
}
```

### 4.2 Middleware per Contesto Richiesta

```typescript
// server/middleware.ts
import { Request, Response, NextFunction } from "express";
import { requestContext } from "./request-context";

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const token = req.session?.arkeToken ?? null;
  
  requestContext.run({ arkeToken: token }, () => {
    next();
  });
}
```

### 4.3 Applicare Middleware

```typescript
// server/index.ts
import { requestContextMiddleware } from "./middleware";

// Dopo session middleware, prima delle routes
app.use(requestContextMiddleware);
```

---

## 5. Client Arke

### 5.1 Configurazione Base

```typescript
// server/arke-client.ts
import { getArkeToken } from "./request-context";

const ARKE_API_URL = process.env.ARKE_API_URL || "https://your-tenant.arke.so/api";
const DEFAULT_TIMEOUT = 30000;

interface ArkeRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  timeout?: number;
}

async function arkeRequest<T>({ method, path, body, timeout }: ArkeRequestOptions): Promise<T> {
  const token = getArkeToken();
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout ?? DEFAULT_TIMEOUT);
  
  try {
    const response = await fetch(`${ARKE_API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Arke API error ${response.status}: ${errorText}`);
    }
    
    return response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}
```

### 5.2 Funzione Login

```typescript
// server/arke-client.ts

interface LoginResponse {
  accessToken: string;  // ATTENZIONE: camelCase, NON access_token!
  user: {
    sub: string;
    exp: number;
    iat: number;
    full_name: string;
    username: string;
    tenant: {
      tenant_id: string;
      tenant_url: string;
    };
    super_admin: boolean;
    roles: string[];
  };
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${ARKE_API_URL}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Credenziali non valide");
    }
    throw new Error(`Login failed: ${response.status}`);
  }
  
  return response.json();
}
```

**⚠️ ERRORE COMUNE:** Il campo token nella risposta è `accessToken` (camelCase), NON `access_token` (snake_case).

---

## 6. Route di Autenticazione

```typescript
// server/routes.ts
import { Router, Request, Response } from "express";
import { login } from "./arke-client";

const router = Router();

// POST /api/login
router.post("/api/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: "Username e password richiesti" });
    }
    
    const result = await login(username, password);
    
    // Rigenerare sessione per prevenire session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regeneration error:", err);
        return res.status(500).json({ error: "Errore interno" });
      }
      
      // Salvare token e dati utente in sessione
      req.session.arkeToken = result.accessToken;
      req.session.user = {
        username: result.user.username,
        full_name: result.user.full_name,
        roles: result.user.roles,
      };
      
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error("Session save error:", saveErr);
          return res.status(500).json({ error: "Errore interno" });
        }
        
        res.json({
          success: true,
          user: req.session.user,
        });
      });
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(401).json({ 
      error: error instanceof Error ? error.message : "Login fallito" 
    });
  }
});

// POST /api/logout
router.post("/api/logout", (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).json({ error: "Errore durante logout" });
    }
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// GET /api/auth/status
router.get("/api/auth/status", (req: Request, res: Response) => {
  if (req.session?.arkeToken && req.session?.user) {
    res.json({
      authenticated: true,
      user: req.session.user,
    });
  } else {
    res.json({ authenticated: false });
  }
});

export default router;
```

---

## 7. Middleware Protezione Route

```typescript
// server/middleware.ts
import { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.arkeToken) {
    return res.status(401).json({ error: "Non autenticato" });
  }
  next();
}

// Uso nelle routes:
// router.get("/api/protected", requireAuth, handler);
```

---

## 8. Frontend React

### 8.1 Pagina Login

```tsx
// client/src/pages/login.tsx
import { useState } from "react";
import { useLocation } from "wouter";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, setLocation] = useLocation();
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include", // IMPORTANTE: include cookies
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Login fallito");
      }
      
      // Redirect a home page
      setLocation("/");
      
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore login");
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
        required
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        required
      />
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={loading}>
        {loading ? "Accesso..." : "Accedi"}
      </button>
    </form>
  );
}
```

### 8.2 Controllo Stato Autenticazione

```tsx
// client/src/App.tsx
import { useState, useEffect } from "react";
import { Route, Switch, Redirect } from "wouter";
import LoginPage from "./pages/login";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<{ username: string; full_name: string } | null>(null);
  
  useEffect(() => {
    checkAuthStatus();
  }, []);
  
  const checkAuthStatus = async () => {
    try {
      const response = await fetch("/api/auth/status", {
        credentials: "include",
      });
      const data = await response.json();
      
      setIsAuthenticated(data.authenticated);
      setUser(data.authenticated ? data.user : null);
    } catch {
      setIsAuthenticated(false);
      setUser(null);
    }
  };
  
  // Loading state
  if (isAuthenticated === null) {
    return <div>Caricamento...</div>;
  }
  
  // Not authenticated: show login
  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={checkAuthStatus} />;
  }
  
  // Authenticated: show app
  return (
    <div>
      <header>
        Benvenuto, {user?.full_name}
        <button onClick={handleLogout}>Logout</button>
      </header>
      <Switch>
        {/* Your routes here */}
      </Switch>
    </div>
  );
  
  async function handleLogout() {
    await fetch("/api/logout", {
      method: "POST",
      credentials: "include",
    });
    setIsAuthenticated(false);
    setUser(null);
  }
}

export default App;
```

---

## 9. Checklist Sicurezza

- [x] **Trust Proxy**: `app.set("trust proxy", 1)` per Replit
- [x] **Session Regeneration**: `req.session.regenerate()` al login
- [x] **HTTP-Only Cookies**: `httpOnly: true` nelle opzioni cookie
- [x] **Secure Cookies**: `secure: true` in produzione
- [x] **SameSite**: `sameSite: "lax"` per protezione CSRF
- [x] **AsyncLocalStorage**: Isolamento token per richieste concorrenti
- [x] **Session Expiry**: `maxAge: 24 * 60 * 60 * 1000` (24 ore)
- [x] **Credentials Include**: `credentials: "include"` in fetch frontend

---

## 10. Troubleshooting

### "Cookie non salvato in produzione"

**Causa:** Manca `app.set("trust proxy", 1)`

**Soluzione:** Aggiungere prima di qualsiasi middleware:
```typescript
app.set("trust proxy", 1);
```

### "Token undefined dopo login"

**Causa:** Campo token sbagliato. Arke restituisce `accessToken`, non `access_token`.

**Soluzione:**
```typescript
// SBAGLIATO
req.session.arkeToken = result.access_token;

// CORRETTO
req.session.arkeToken = result.accessToken;
```

### "401 su richieste dopo login"

**Causa:** Token non incluso nelle richieste successive.

**Soluzione:** Verificare che il middleware `requestContextMiddleware` sia attivo e che `getArkeToken()` venga usato nel client Arke.

### "Token sbagliato tra utenti diversi"

**Causa:** Token non isolato per richiesta.

**Soluzione:** Usare `AsyncLocalStorage` come descritto nella sezione 4.

---

## 11. Variabili Ambiente Richieste

```env
# .env
ARKE_API_URL=https://your-tenant.arke.so/api
SESSION_SECRET=your-very-long-random-secret-key
NODE_ENV=production  # o development
```

---

## 12. Struttura File Consigliata

```
server/
├── index.ts              # Setup Express + middleware
├── routes.ts             # Route auth + altre
├── arke-client.ts        # Client HTTP per Arke
├── request-context.ts    # AsyncLocalStorage setup
├── middleware.ts         # requestContextMiddleware + requireAuth
└── types.ts              # Estensioni tipi TypeScript

client/src/
├── App.tsx               # Auth state management
└── pages/
    └── login.tsx         # Pagina login
```

---

*Guida basata sull'implementazione La Lucerna Operations Management - Gennaio 2026*
