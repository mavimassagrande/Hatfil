import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";

function useDebounce(value: string, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

interface ContactEmail {
  email: string;
  name: string;
}

interface ContactPhone {
  name: string;
  phone: string;
}

interface ContactSummary {
  id?: string;
  name: string;
  vat_no: string;
  default_currency: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  categories: string[];
}

function LoadingSkeleton() {
  return (
    <TableBody>
      {Array.from({ length: 8 }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: 6 }).map((_, j) => (
            <TableCell key={j}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

function ContactTable({ data, isLoading, testIdPrefix }: {
  data: ContactSummary[];
  isLoading: boolean;
  testIdPrefix: string;
}) {
  return (
    <Table data-testid={`table-${testIdPrefix}`}>
      <TableHeader>
        <TableRow>
          <TableHead>Nome</TableHead>
          <TableHead>P.IVA</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Telefono</TableHead>
          <TableHead>Valuta</TableHead>
          <TableHead>Categorie</TableHead>
        </TableRow>
      </TableHeader>
      {isLoading ? (
        <LoadingSkeleton />
      ) : (
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                Nessun risultato trovato
              </TableCell>
            </TableRow>
          ) : (
            data.map((contact, index) => (
              <TableRow key={contact.id ?? index} data-testid={`row-${testIdPrefix}-${contact.id ?? index}`}>
                <TableCell data-testid={`text-name-${testIdPrefix}-${contact.id ?? index}`} className="font-medium">
                  {contact.name}
                </TableCell>
                <TableCell data-testid={`text-vat-${testIdPrefix}-${contact.id ?? index}`}>
                  {contact.vat_no || "—"}
                </TableCell>
                <TableCell data-testid={`text-email-${testIdPrefix}-${contact.id ?? index}`}>
                  {contact.emails?.[0]?.email || "—"}
                </TableCell>
                <TableCell data-testid={`text-phone-${testIdPrefix}-${contact.id ?? index}`}>
                  {contact.phones?.[0]?.phone || "—"}
                </TableCell>
                <TableCell data-testid={`text-currency-${testIdPrefix}-${contact.id ?? index}`}>
                  {contact.default_currency || "—"}
                </TableCell>
                <TableCell data-testid={`text-categories-${testIdPrefix}-${contact.id ?? index}`}>
                  <div className="flex flex-wrap gap-1">
                    {contact.categories?.length > 0
                      ? contact.categories.map((cat) => (
                          <Badge key={cat} variant="secondary" className="no-default-active-elevate">
                            {cat}
                          </Badge>
                        ))
                      : "—"}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      )}
    </Table>
  );
}

export default function ContactsPage() {
  const [activeTab, setActiveTab] = useState("clienti");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const { data: customersData, isLoading: customersLoading } = useQuery<{ success: boolean; data: ContactSummary[] }>({
    queryKey: ["/api/customers", debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("limit", "100");
      const res = await fetch(`/api/customers?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch customers");
      return res.json();
    },
    enabled: activeTab === "clienti",
  });

  const { data: suppliersData, isLoading: suppliersLoading } = useQuery<{ success: boolean; data: ContactSummary[] }>({
    queryKey: ["/api/suppliers", debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("offset", "0");
      const res = await fetch(`/api/suppliers?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch suppliers");
      return res.json();
    },
    enabled: activeTab === "fornitori",
  });

  const customers = customersData?.data ?? [];
  const suppliers = suppliersData?.data ?? [];

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold" data-testid="text-page-title">Contatti</h1>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabsList data-testid="tabs-contacts">
            <TabsTrigger value="clienti" data-testid="tab-clienti">
              Clienti
              {!customersLoading && customers.length > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground" data-testid="text-count-clienti">
                  ({customers.length})
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="fornitori" data-testid="tab-fornitori">
              Fornitori
              {!suppliersLoading && suppliers.length > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground" data-testid="text-count-fornitori">
                  ({suppliers.length})
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Cerca..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-64"
              data-testid="input-search-contacts"
            />
          </div>
        </div>

        <TabsContent value="clienti" data-testid="content-clienti">
          <ContactTable
            data={customers}
            isLoading={customersLoading}
            testIdPrefix="clienti"
          />
        </TabsContent>

        <TabsContent value="fornitori" data-testid="content-fornitori">
          <ContactTable
            data={suppliers}
            isLoading={suppliersLoading}
            testIdPrefix="fornitori"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
