import { useState, useEffect } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import ChatPage from "@/pages/chat";
import ConfiguratorPage from "@/pages/configurator";
import DDTInboundPage from "@/pages/ddt-inbound";
import TurkeyFulfillmentPage from "@/pages/turkey-fulfillment";
import SalesOrdersPage from "@/pages/sales-orders";
import ProductsPage from "@/pages/products";
import InventoryPage from "@/pages/inventory";
import InventoryValuePage from "@/pages/inventory-value";
import ContactsPage from "@/pages/contacts";
import LoginPage from "@/pages/login";
import { TopNavBar } from "@/components/top-nav-bar";

interface AuthUser {
  username: string;
  full_name: string;
  roles: string[];
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={ChatPage} />
      <Route path="/vendite" component={SalesOrdersPage} />
      <Route path="/catalogo/configuratore" component={ConfiguratorPage} />
      <Route path="/catalogo/articoli" component={ProductsPage} />
      <Route path="/magazzino/inventario" component={InventoryPage} />
      <Route path="/magazzino/valore-inventario" component={InventoryValuePage} />
      <Route path="/magazzino/ddt-inbound" component={DDTInboundPage} />
      <Route path="/magazzino/evasione-rapida" component={TurkeyFulfillmentPage} />
      <Route path="/contatti" component={ContactsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  return (
    <div className="flex flex-col h-screen">
      <TopNavBar user={user} onLogout={onLogout} />
      <main className="flex-1 overflow-auto">
        <Router />
      </main>
    </div>
  );
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

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

  const handleLogout = async () => {
    await fetch("/api/logout", {
      method: "POST",
      credentials: "include",
    });
    setIsAuthenticated(false);
    setUser(null);
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Caricamento...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <LoginPage onLoginSuccess={checkAuthStatus} />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthenticatedApp user={user!} onLogout={handleLogout} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
