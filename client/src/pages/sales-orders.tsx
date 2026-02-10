import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Search } from "lucide-react";

interface SalesOrder {
  id: string;
  internal_id: string;
  status: "draft" | "accepted" | "sent";
  shipped: "completed" | "not shipped" | "partial";
  expected_shipping_time: string | null;
  total_vat_incl: number;
  default_currency: string;
  customer_attr: { name: string; country: string; vat: string } | null;
  external_id: string | null;
  priority: number;
  time: string;
  sales_channel_attr: { name: string } | null;
}

type StatusFilter = "all" | "draft" | "accepted" | "sent";

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: "Tutti", value: "all" },
  { label: "Bozza", value: "draft" },
  { label: "Accettati", value: "accepted" },
  { label: "Spediti", value: "sent" },
];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "-";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatCurrency(amount: number, currency: string = "EUR"): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function getStatusBadge(status: string) {
  switch (status) {
    case "draft":
      return <Badge variant="secondary" data-testid={`badge-status-${status}`}>Bozza</Badge>;
    case "accepted":
      return <Badge variant="default" data-testid={`badge-status-${status}`}>Accettato</Badge>;
    case "sent":
      return <Badge variant="outline" data-testid={`badge-status-${status}`}>Spedito</Badge>;
    default:
      return <Badge variant="outline" data-testid={`badge-status-${status}`}>{status}</Badge>;
  }
}

function getShippedBadge(shipped: string) {
  switch (shipped) {
    case "completed":
      return <Badge variant="default" data-testid={`badge-shipped-${shipped}`}>Completata</Badge>;
    case "partial":
      return <Badge variant="secondary" data-testid={`badge-shipped-${shipped}`}>Parziale</Badge>;
    case "not shipped":
      return <Badge variant="outline" data-testid={`badge-shipped-not-shipped`}>Non spedito</Badge>;
    default:
      return <Badge variant="outline" data-testid={`badge-shipped-${shipped}`}>{shipped}</Badge>;
  }
}

export default function SalesOrdersPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const buildUrl = () => {
    const params = new URLSearchParams();
    if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
    if (searchQuery) params.set("search", searchQuery);
    params.set("limit", "100");
    const qs = params.toString();
    return `/api/sales/orders${qs ? `?${qs}` : ""}`;
  };

  const { data, isLoading } = useQuery<{ success: boolean; data: SalesOrder[] }>({
    queryKey: ["/api/sales/orders", statusFilter, searchQuery],
    queryFn: async () => {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const orders = data?.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold" data-testid="text-page-title">
          Ordini di Vendita
        </h1>
        {!isLoading && (
          <Badge variant="secondary" data-testid="badge-order-count">
            {orders.length}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            data-testid="input-search"
            placeholder="Cerca ordini..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((filter) => (
            <Button
              key={filter.value}
              data-testid={`button-filter-${filter.value}`}
              variant={statusFilter === filter.value ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(filter.value)}
              className="toggle-elevate"
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3" data-testid="loading-skeleton">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground" data-testid="text-empty-state">
          Nessun ordine trovato
        </div>
      ) : (
        <Table data-testid="table-sales-orders">
          <TableHeader>
            <TableRow>
              <TableHead>Ordine</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>Stato</TableHead>
              <TableHead>Spedizione</TableHead>
              <TableHead>Data Spedizione</TableHead>
              <TableHead className="text-right">Totale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id} data-testid={`row-order-${order.id}`}>
                <TableCell className="font-medium" data-testid={`text-internal-id-${order.id}`}>
                  {order.internal_id}
                </TableCell>
                <TableCell data-testid={`text-customer-${order.id}`}>
                  {order.customer_attr?.name ?? "-"}
                </TableCell>
                <TableCell>
                  {getStatusBadge(order.status)}
                </TableCell>
                <TableCell>
                  {getShippedBadge(order.shipped)}
                </TableCell>
                <TableCell className="text-muted-foreground" data-testid={`text-shipping-date-${order.id}`}>
                  {formatDate(order.expected_shipping_time)}
                </TableCell>
                <TableCell className="text-right font-medium" data-testid={`text-total-${order.id}`}>
                  {formatCurrency(order.total_vat_incl, order.default_currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
