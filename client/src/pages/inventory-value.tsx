import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, TrendingUp, Package, Layers } from "lucide-react";

interface FamilyValue {
  masterCode: string;
  masterName: string;
  variantCount: number;
  totalQty: number;
  totalValue: number;
  uom: string;
  avgPrice: number;
  pricedCount: number;
}

interface InventoryValueResponse {
  success: boolean;
  grandTotal: number;
  grandQty: number;
  familyCount: number;
  families: FamilyValue[];
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatQty(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4" data-testid="loading-skeleton">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

export default function InventoryValuePage() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data, isLoading, isError } = useQuery<InventoryValueResponse>({
    queryKey: ["/api/inventory/value"],
    queryFn: async () => {
      const res = await fetch("/api/inventory/value");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const families = data?.families ?? [];

  const filtered = useMemo(() => {
    if (!searchQuery) return families;
    const q = searchQuery.toLowerCase();
    return families.filter(
      (f) =>
        f.masterCode.toLowerCase().includes(q) ||
        f.masterName.toLowerCase().includes(q)
    );
  }, [families, searchQuery]);

  const filteredTotal = useMemo(
    () => filtered.reduce((sum, f) => sum + f.totalValue, 0),
    [filtered]
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold" data-testid="text-page-title">
          Valore Inventario
        </h1>
        {!isLoading && data && (
          <Badge variant="secondary" data-testid="badge-family-count">
            {data.familyCount} famiglie
          </Badge>
        )}
      </div>

      {isLoading && <LoadingSkeleton />}

      {isError && (
        <div
          className="text-sm text-muted-foreground"
          data-testid="text-error-message"
        >
          Errore nel caricamento dei dati.
        </div>
      )}

      {!isLoading && !isError && data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="p-4" data-testid="card-grand-total">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-primary/10 p-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Valore Totale</p>
                  <p className="text-xl font-bold" data-testid="text-grand-total">
                    {formatCurrency(data.grandTotal)}
                  </p>
                </div>
              </div>
            </Card>
            <Card className="p-4" data-testid="card-grand-qty">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-primary/10 p-2">
                  <Package className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Quantita Totale</p>
                  <p className="text-xl font-bold" data-testid="text-grand-qty">
                    {formatQty(data.grandQty)} kg
                  </p>
                </div>
              </div>
            </Card>
            <Card className="p-4" data-testid="card-family-count">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-primary/10 p-2">
                  <Layers className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Famiglie Prodotto</p>
                  <p className="text-xl font-bold" data-testid="text-family-count-card">
                    {data.familyCount}
                  </p>
                </div>
              </div>
            </Card>
          </div>

          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Cerca famiglia prodotto..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search"
            />
          </div>

          {searchQuery && (
            <p className="text-sm text-muted-foreground" data-testid="text-filtered-total">
              Valore filtrato: <span className="font-semibold text-foreground">{formatCurrency(filteredTotal)}</span>
            </p>
          )}

          <div data-testid="value-table-container">
            <Table data-testid="table-inventory-value">
              <TableHeader>
                <TableRow>
                  <TableHead>Codice Famiglia</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead className="text-center">Varianti</TableHead>
                  <TableHead className="text-right">Quantita</TableHead>
                  <TableHead>UdM</TableHead>
                  <TableHead className="text-right">Prezzo Medio</TableHead>
                  <TableHead className="text-right">Valore</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center text-muted-foreground h-24"
                      data-testid="text-empty-state"
                    >
                      Nessuna famiglia trovata.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((f) => (
                    <TableRow
                      key={f.masterCode}
                      data-testid={`row-family-${f.masterCode}`}
                    >
                      <TableCell
                        className="font-medium"
                        data-testid={`text-code-${f.masterCode}`}
                      >
                        {f.masterCode}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground"
                        data-testid={`text-name-${f.masterCode}`}
                      >
                        {f.masterName}
                      </TableCell>
                      <TableCell
                        className="text-center"
                        data-testid={`text-variants-${f.masterCode}`}
                      >
                        {f.variantCount}
                      </TableCell>
                      <TableCell
                        className="text-right"
                        data-testid={`text-qty-${f.masterCode}`}
                      >
                        {formatQty(f.totalQty)}
                      </TableCell>
                      <TableCell data-testid={`text-uom-${f.masterCode}`}>
                        {f.uom}
                      </TableCell>
                      <TableCell
                        className="text-right text-muted-foreground"
                        data-testid={`text-avg-price-${f.masterCode}`}
                      >
                        {f.avgPrice > 0 ? formatCurrency(f.avgPrice) : "—"}
                      </TableCell>
                      <TableCell
                        className="text-right font-semibold text-green-600 dark:text-green-400"
                        data-testid={`text-value-${f.masterCode}`}
                      >
                        {f.totalValue > 0 ? formatCurrency(f.totalValue) : "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
