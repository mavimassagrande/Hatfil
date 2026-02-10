import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { LogOut, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import hatfilLogo from "@assets/image_1770396060374.png";

interface TopNavBarProps {
  user: { username: string; full_name: string; roles: string[] };
  onLogout: () => void;
}

const catalogoItems = [
  { label: "Configuratore", href: "/catalogo/configuratore" },
  { label: "Articoli", href: "/catalogo/articoli" },
];

const magazzinoItems = [
  { label: "Inventario", href: "/magazzino/inventario" },
  { label: "Valore Inventario", href: "/magazzino/valore-inventario" },
  { label: "DDT in Ingresso", href: "/magazzino/ddt-inbound" },
  { label: "Evasione Rapida", href: "/magazzino/evasione-rapida" },
];

export function TopNavBar({ user, onLogout }: TopNavBarProps) {
  const [location, setLocation] = useLocation();

  const isActive = (path: string) => {
    if (path === "/") return location === "/";
    return location.startsWith(path);
  };

  const navLinkClass = (path: string) =>
    `inline-flex h-10 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer ${
      isActive(path)
        ? "text-primary font-semibold"
        : "text-muted-foreground"
    }`;

  const triggerBtnClass = (prefix: string) =>
    `inline-flex h-10 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground gap-1 cursor-pointer ${
      isActive(prefix)
        ? "text-primary font-semibold"
        : "text-muted-foreground"
    }`;

  return (
    <header
      className="sticky top-0 z-50 h-14 border-b bg-background grid items-center px-4"
      style={{ gridTemplateColumns: "auto 1fr auto" }}
      data-testid="top-nav-bar"
    >
      <div className="flex items-center gap-2">
        <img src={hatfilLogo} alt="HATFIL" className="h-8 w-8 rounded-md" data-testid="img-company-logo" />
        <span className="text-sm font-semibold tracking-tight" data-testid="text-company-name">
          HATFIL
        </span>
      </div>

      <nav className="flex items-center justify-center gap-1">
        <Link href="/" data-testid="nav-link-home">
          <span className={navLinkClass("/")}>Home</span>
        </Link>

        <Link href="/vendite" data-testid="nav-link-vendite">
          <span className={navLinkClass("/vendite")}>Vendite</span>
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={triggerBtnClass("/catalogo")} data-testid="nav-trigger-catalogo">
              Catalogo
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {catalogoItems.map((item) => (
              <DropdownMenuItem
                key={item.href}
                className={`cursor-pointer ${location === item.href ? "font-semibold" : ""}`}
                data-testid={`nav-link-${item.href.split("/").pop()}`}
                onClick={() => setLocation(item.href)}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={triggerBtnClass("/magazzino")} data-testid="nav-trigger-magazzino">
              Magazzino
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {magazzinoItems.map((item) => (
              <DropdownMenuItem
                key={item.href}
                className={`cursor-pointer ${location === item.href ? "font-semibold" : ""}`}
                data-testid={`nav-link-${item.href.split("/").pop()}`}
                onClick={() => setLocation(item.href)}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Link href="/contatti" data-testid="nav-link-contatti">
          <span className={navLinkClass("/contatti")}>Contatti</span>
        </Link>
      </nav>

      <div className="flex items-center justify-end gap-3">
        <span className="text-sm text-muted-foreground" data-testid="text-user-fullname">
          {user.full_name || user.username}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          data-testid="button-logout"
        >
          <LogOut className="h-4 w-4 mr-2" />
          Esci
        </Button>
      </div>
    </header>
  );
}
