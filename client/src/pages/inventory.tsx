import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, FileDown, Printer } from "lucide-react";

interface InventoryItem {
  id: string;
  product_id: string;
  internal_id: string;
  name: string;
  categories: string[];
  uom: string;
  lot: string;
  external_lot: string;
  order_id: string;
  order_internal_id: string;
  order_external_id: string;
  warehouse_id: string;
  warehouse_attr: { id: string; name: string };
  buckets: {
    planned: number;
    in_production: number;
    available: number;
    reserved: number;
    shipped: number;
  };
  created: { at: string };
}

interface InventoryResponse {
  success: boolean;
  data: InventoryItem[];
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3" data-testid="loading-skeleton">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function extractMasterCode(internalId: string): string {
  const parts = internalId.split(" - ");
  return parts[0] || internalId;
}

export default function InventoryPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false);
  const [selectedMasters, setSelectedMasters] = useState<Set<string>>(new Set());
  const [masterSearch, setMasterSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data, isLoading, isError } = useQuery<InventoryResponse>({
    queryKey: ["/api/inventory"],
    queryFn: async () => {
      const res = await fetch("/api/inventory");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const allItems = data?.data ?? [];

  const masterProducts = useMemo(() => {
    const masterMap = new Map<string, { code: string; count: number; totalKg: number }>();
    for (const item of allItems) {
      if (item.buckets.available <= 0) continue;
      const code = extractMasterCode(item.internal_id);
      const existing = masterMap.get(code);
      const qty = item.uom === "kilogram" || item.uom === "kg" ? item.buckets.available : 0;
      if (existing) {
        existing.count++;
        existing.totalKg += qty;
      } else {
        masterMap.set(code, { code, count: 1, totalKg: qty });
      }
    }
    return Array.from(masterMap.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [allItems]);

  const filteredMasters = useMemo(() => {
    if (!masterSearch) return masterProducts;
    const q = masterSearch.toLowerCase();
    return masterProducts.filter((m) => m.code.toLowerCase().includes(q));
  }, [masterProducts, masterSearch]);

  const items = allItems
    .filter((item) => item.buckets.available !== 0)
    .filter((item) => {
      if (!debouncedSearch) return true;
      const q = debouncedSearch.toLowerCase();
      return (
        (item.internal_id ?? "").toLowerCase().includes(q) ||
        (item.name ?? "").toLowerCase().includes(q) ||
        (item.external_lot ?? "").toLowerCase().includes(q) ||
        (item.warehouse_attr?.name ?? "").toLowerCase().includes(q)
      );
    })
    .sort((a, b) => (a.internal_id ?? "").localeCompare(b.internal_id ?? ""));

  const toggleMaster = (code: string) => {
    setSelectedMasters((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedMasters.size === filteredMasters.length) {
      setSelectedMasters(new Set());
    } else {
      setSelectedMasters(new Set(filteredMasters.map((m) => m.code)));
    }
  };

  const handlePrint = () => {
    const mastersParam = selectedMasters.size > 0
      ? `?masters=${Array.from(selectedMasters).join(",")}`
      : "";
    window.open(`/api/inventory/warehouse-stock/pdf${mastersParam}`, "_blank");
    setPdfDialogOpen(false);
  };

  const openPdfDialog = () => {
    setSelectedMasters(new Set());
    setMasterSearch("");
    setPdfDialogOpen(true);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            Inventario
          </h1>
          {!isLoading && (
            <Badge variant="secondary" data-testid="badge-inventory-count">
              {items.length}
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          onClick={openPdfDialog}
          disabled={isLoading || allItems.length === 0}
          data-testid="button-open-pdf-dialog"
        >
          <Printer className="mr-2 h-4 w-4" />
          Stampa Giacenze
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Cerca per codice, nome, lotto..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search"
        />
      </div>

      {isLoading && <LoadingSkeleton />}

      {isError && (
        <div
          className="text-sm text-muted-foreground"
          data-testid="text-error-message"
        >
          Errore nel caricamento dei dati di inventario.
        </div>
      )}

      {!isLoading && !isError && (
        <div data-testid="inventory-table-container">
          <Table data-testid="table-inventory">
            <TableHeader>
              <TableRow>
                <TableHead>Codice</TableHead>
                <TableHead>Prodotto</TableHead>
                <TableHead>Magazzino</TableHead>
                <TableHead>Lotto</TableHead>
                <TableHead className="text-right">Disponibile</TableHead>
                <TableHead>UdM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground h-24"
                    data-testid="text-empty-state"
                  >
                    Nessun elemento trovato.
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow
                    key={item.id}
                    data-testid={`row-inventory-${item.id}`}
                  >
                    <TableCell data-testid={`text-internal-id-${item.id}`}>
                      {item.internal_id}
                    </TableCell>
                    <TableCell data-testid={`text-name-${item.id}`}>
                      {item.name}
                    </TableCell>
                    <TableCell data-testid={`text-warehouse-${item.id}`}>
                      {item.warehouse_attr?.name ?? "—"}
                    </TableCell>
                    <TableCell data-testid={`text-lot-${item.id}`}>
                      {item.external_lot ?? "—"}
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium ${
                        item.buckets.available > 0
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                      data-testid={`text-available-${item.id}`}
                    >
                      {formatNumber(item.buckets.available)}
                    </TableCell>
                    <TableCell data-testid={`text-uom-${item.id}`}>
                      {item.uom}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={pdfDialogOpen} onOpenChange={setPdfDialogOpen}>
        <DialogContent className="max-w-lg" data-testid="dialog-pdf-masters">
          <DialogHeader>
            <DialogTitle>Stampa Giacenze Brescia</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Seleziona le famiglie di prodotto da includere nel PDF, oppure stampa tutto lasciando vuota la selezione.
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Cerca famiglia..."
              value={masterSearch}
              onChange={(e) => setMasterSearch(e.target.value)}
              className="pl-9"
              data-testid="input-master-search"
            />
          </div>
          <div className="flex items-center gap-2 py-1">
            <Checkbox
              id="select-all"
              checked={filteredMasters.length > 0 && selectedMasters.size === filteredMasters.length}
              onCheckedChange={toggleAll}
              data-testid="checkbox-select-all"
            />
            <label htmlFor="select-all" className="text-sm font-medium cursor-pointer">
              Seleziona tutto ({filteredMasters.length})
            </label>
            {selectedMasters.size > 0 && (
              <Badge variant="secondary" className="ml-auto" data-testid="badge-selected-count">
                {selectedMasters.size} selezionat{selectedMasters.size === 1 ? "o" : "i"}
              </Badge>
            )}
          </div>
          <ScrollArea className="h-64 border rounded-md">
            <div className="p-2 space-y-1">
              {filteredMasters.map((m) => (
                <label
                  key={m.code}
                  className="flex items-center gap-3 px-2 py-1.5 rounded-md hover-elevate cursor-pointer"
                  data-testid={`label-master-${m.code}`}
                >
                  <Checkbox
                    checked={selectedMasters.has(m.code)}
                    onCheckedChange={() => toggleMaster(m.code)}
                    data-testid={`checkbox-master-${m.code}`}
                  />
                  <span className="text-sm font-medium flex-1">{m.code}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.count} var. | {m.totalKg.toFixed(1)} kg
                  </span>
                </label>
              ))}
              {filteredMasters.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-no-masters">
                  Nessuna famiglia trovata.
                </p>
              )}
            </div>
          </ScrollArea>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPdfDialogOpen(false)} data-testid="button-cancel-pdf">
              Annulla
            </Button>
            <Button onClick={handlePrint} data-testid="button-generate-pdf">
              <FileDown className="mr-2 h-4 w-4" />
              {selectedMasters.size > 0
                ? `Stampa ${selectedMasters.size} famigli${selectedMasters.size === 1 ? "a" : "e"}`
                : "Stampa tutto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
