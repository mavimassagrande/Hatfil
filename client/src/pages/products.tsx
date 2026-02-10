import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";

interface Product {
  id: string;
  internal_id: string;
  name: string;
  categories: string[];
  type: "producible" | "purchasable" | "bundle";
  uom: string;
  prices: {
    unit: number;
    currency: string;
    vat: number;
    base_price: number;
  };
  master_type: string;
  semi_id: string;
  created: {
    at: string;
    by: { full_name: string };
  };
}

interface ProductsResponse {
  success: boolean;
  data: Product[];
}

const typeBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
  producible: "default",
  purchasable: "secondary",
  bundle: "outline",
};

const typeLabel: Record<string, string> = {
  producible: "Producibile",
  purchasable: "Acquistabile",
  bundle: "Bundle",
};

function formatEUR(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export default function ProductsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useQuery<ProductsResponse>({
    queryKey: ["/api/products", debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("limit", "100");
      const qs = params.toString();
      const res = await fetch(`/api/products${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const products = data?.data ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold" data-testid="text-page-title">
          Articoli
        </h1>
        {!isLoading && (
          <Badge variant="secondary" data-testid="badge-products-count">
            {products.length}
          </Badge>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          data-testid="input-search"
          placeholder="Cerca articoli..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3" data-testid="loading-skeleton">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div
          className="text-center py-12 text-muted-foreground"
          data-testid="text-empty-state"
        >
          Nessun articolo trovato
        </div>
      ) : (
        <div className="border rounded-md">
          <Table data-testid="table-products">
            <TableHeader>
              <TableRow>
                <TableHead>Codice</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Categorie</TableHead>
                <TableHead>UdM</TableHead>
                <TableHead className="text-right">Prezzo</TableHead>
                <TableHead className="text-right">IVA%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow
                  key={product.id}
                  data-testid={`row-product-${product.id}`}
                >
                  <TableCell
                    className="font-mono text-sm"
                    data-testid={`text-internal-id-${product.id}`}
                  >
                    {product.internal_id}
                  </TableCell>
                  <TableCell
                    className="font-medium"
                    data-testid={`text-name-${product.id}`}
                  >
                    {product.name}
                  </TableCell>
                  <TableCell data-testid={`badge-type-${product.id}`}>
                    <Badge
                      variant={typeBadgeVariant[product.type] ?? "default"}
                    >
                      {typeLabel[product.type] ?? product.type}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground"
                    data-testid={`text-categories-${product.id}`}
                  >
                    {product.categories?.join(", ") || "-"}
                  </TableCell>
                  <TableCell data-testid={`text-uom-${product.id}`}>
                    {product.uom || "-"}
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums"
                    data-testid={`text-price-${product.id}`}
                  >
                    {product.prices?.unit != null
                      ? formatEUR(product.prices.unit)
                      : "-"}
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums"
                    data-testid={`text-vat-${product.id}`}
                  >
                    {product.prices?.vat != null
                      ? `${product.prices.vat}%`
                      : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
