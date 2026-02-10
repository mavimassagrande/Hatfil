import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Search, Check, AlertCircle, Package, Palette, ArrowRight, RefreshCw, User, Plus, ArrowLeft, FileDown, Edit, RotateCcw, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Link } from "wouter";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface MasterProduct {
  id: number;
  code: string;
  name: string;
  basePrice: string;
  uom: string;
  stockTier: string;
  category: string;
  folderId: number;
  folderCode: string;
  folderName: string;
}

interface ColorItem {
  id: number;
  code: string;
  name: string | null;
  folderId: number;
  stockTiers: string[];
  isStock: boolean;
  isGenerated: boolean;
  arkeProductId?: string;
}

interface ProductDetails extends MasterProduct {
  colors: ColorItem[];
  stockCount: number;
  totalColors: number;
  generatedCount: number;
}

interface DuplicateCheckResult {
  duplicates: { colorId: number; colorCode: string; arkeInternalId: string; exists: boolean }[];
  available: { colorId: number; colorCode: string; arkeInternalId: string }[];
  masterProduct: MasterProduct;
}

interface GenerateResult {
  success: boolean;
  results: { colorCode: string; arkeInternalId: string; success: boolean; arkeProductId?: string; error?: string }[];
  summary: { total: number; success: number; failed: number };
}

interface CustomerSearchResult {
  id: string;
  name: string;
  internal_id?: string;
}

interface CustomColorResult {
  success: boolean;
  arkeInternalId: string;
  arkeProductId?: string;
  supplierAssociated: boolean;
  customerName: string;
  error?: string;
}

interface GeneratedProductInfo {
  id: number;
  arkeProductId: string | null;
  arkeInternalId: string;
  syncStatus: string;
  createdAt: string;
  masterProductCode: string;
  colorCode: string;
  colorName: string | null;
}

export default function ConfiguratorPage() {
  const { toast } = useToast();
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [selectedColorIds, setSelectedColorIds] = useState<Set<number>>(new Set());
  const [searchFilter, setSearchFilter] = useState("");
  const [stockTierFilter, setStockTierFilter] = useState<string>("all");
  const [step, setStep] = useState<"select" | "colors" | "preview" | "result">("select");
  const [duplicateResult, setDuplicateResult] = useState<DuplicateCheckResult | null>(null);
  
  // Custom color state
  const [colorMode, setColorMode] = useState<"standard" | "custom">("standard");
  const [customColorCode, setCustomColorCode] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSearchResult | null>(null);
  const [customerSearchResults, setCustomerSearchResults] = useState<CustomerSearchResult[]>([]);
  const [isSearchingCustomer, setIsSearchingCustomer] = useState(false);
  const [customColorResult, setCustomColorResult] = useState<CustomColorResult | null>(null);
  const [generateResult, setGenerateResult] = useState<GenerateResult | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState<MasterProduct | null>(null);
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    basePrice: "",
    uom: "kilogram",
    folderId: "",
    stockTier: "STOCK_4",
    category: "evolution",
  });
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [syncProductId, setSyncProductId] = useState<number | null>(null);

  const { data: masterProducts, isLoading: loadingProducts } = useQuery<MasterProduct[]>({
    queryKey: ["/api/configurator/master-products"],
  });

  const { data: productDetails, isLoading: loadingDetails } = useQuery<ProductDetails>({
    queryKey: ["/api/configurator/master-products", selectedProductId],
    enabled: !!selectedProductId,
  });

  const { data: colorFolders } = useQuery<{ id: number; code: string; name: string }[]>({
    queryKey: ["/api/configurator/folders"],
  });

  const { data: generatedProductsList } = useQuery<GeneratedProductInfo[]>({
    queryKey: ["/api/configurator/generated-products"],
  });

  const checkDuplicatesMutation = useMutation({
    mutationFn: async (params: { masterProductId: number; colorIds: number[] }) => {
      const res = await apiRequest("POST", "/api/configurator/check-duplicates", params);
      return res.json() as Promise<DuplicateCheckResult>;
    },
    onSuccess: (data) => {
      setDuplicateResult(data);
      setStep("preview");
    },
    onError: (error) => {
      toast({ title: "Errore verifica duplicati", description: error.message, variant: "destructive" });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async (params: { masterProductId: number; colorIds: number[] }) => {
      const res = await apiRequest("POST", "/api/configurator/generate-products", params);
      return res.json() as Promise<GenerateResult>;
    },
    onSuccess: (data) => {
      setGenerateResult(data);
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["/api/configurator/master-products", selectedProductId] });
      toast({
        title: "Generazione completata",
        description: `${data.summary.success} prodotti creati su Arke`,
      });
    },
    onError: (error) => {
      toast({ title: "Errore generazione", description: error.message, variant: "destructive" });
    },
  });

  const generateCustomMutation = useMutation({
    mutationFn: async (params: { masterProductId: number; colorCode: string; customerId: string; customerName: string }) => {
      const res = await apiRequest("POST", "/api/configurator/generate-custom-product", params);
      return res.json() as Promise<CustomColorResult>;
    },
    onSuccess: (data) => {
      if (data.success) {
        setCustomColorResult(data);
        setStep("result");
        toast({
          title: "Prodotto creato",
          description: `${data.arkeInternalId} creato per ${data.customerName}`,
        });
      } else {
        toast({ title: "Errore", description: data.error, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Errore generazione custom", description: error.message, variant: "destructive" });
    },
  });

  const createMasterMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await apiRequest("POST", "/api/configurator/master-products", {
        ...data,
        folderId: parseInt(data.folderId),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/configurator/master-products"] });
      setShowCreateDialog(false);
      resetForm();
      toast({ title: "Prodotto creato", description: "Prodotto master aggiunto con successo" });
    },
    onError: (error: Error) => {
      toast({ title: "Errore creazione", description: error.message, variant: "destructive" });
    },
  });

  const updateMasterMutation = useMutation({
    mutationFn: async (data: { id: number } & typeof formData) => {
      const { id, ...body } = data;
      const res = await apiRequest("PUT", `/api/configurator/master-products/${id}`, {
        ...body,
        folderId: parseInt(body.folderId),
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/configurator/master-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/configurator/generated-products"] });
      setShowEditDialog(false);
      setEditingProduct(null);
      resetForm();
      const syncMsg = data.variantsMarkedForSync > 0 
        ? ` ${data.variantsMarkedForSync} varianti segnate per sincronizzazione.`
        : "";
      toast({ title: "Prodotto aggiornato", description: `Modifiche salvate.${syncMsg}` });
    },
    onError: (error: Error) => {
      toast({ title: "Errore aggiornamento", description: error.message, variant: "destructive" });
    },
  });

  const syncVariantsMutation = useMutation({
    mutationFn: async (masterProductId: number) => {
      const res = await apiRequest("POST", "/api/configurator/sync-variants", { masterProductId });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/configurator/generated-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/configurator/master-products"] });
      setShowSyncDialog(false);
      setSyncProductId(null);
      if (data.totalFailed > 0) {
        toast({ 
          title: "Sincronizzazione parziale", 
          description: `${data.totalSynced} aggiornati, ${data.totalFailed} falliti`,
          variant: "destructive" 
        });
      } else {
        toast({ 
          title: "Sincronizzazione completata", 
          description: `${data.totalSynced} varianti aggiornate su Arke` 
        });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Errore sincronizzazione", description: error.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData({
      code: "",
      name: "",
      basePrice: "",
      uom: "kilogram",
      folderId: "",
      stockTier: "STOCK_4",
      category: "evolution",
    });
  };

  const openEditDialog = (product: MasterProduct, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProduct(product);
    setFormData({
      code: product.code,
      name: product.name,
      basePrice: product.basePrice,
      uom: product.uom,
      folderId: product.folderId.toString(),
      stockTier: product.stockTier,
      category: product.category,
    });
    setShowEditDialog(true);
  };

  const openSyncDialog = (productId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSyncProductId(productId);
    setShowSyncDialog(true);
  };

  const getProductSyncStatus = (productId: number) => {
    if (!generatedProductsList) return { total: 0, needsUpdate: 0, synced: 0, failed: 0 };
    const variants = generatedProductsList.filter(g => g.masterProductCode === 
      masterProducts?.find(p => p.id === productId)?.code
    );
    return {
      total: variants.length,
      needsUpdate: variants.filter(v => v.syncStatus === "needs_update").length,
      synced: variants.filter(v => v.syncStatus === "synced").length,
      failed: variants.filter(v => v.syncStatus === "failed").length,
    };
  };

  const handleSearchCustomer = async (query: string) => {
    if (query.length < 2) {
      setCustomerSearchResults([]);
      return;
    }
    setIsSearchingCustomer(true);
    try {
      const res = await apiRequest("GET", `/api/arke/customers?search=${encodeURIComponent(query)}&limit=10`);
      const data = await res.json();
      if (data.success && data.data) {
        setCustomerSearchResults(data.data.map((c: { id: string; name: string; internal_id?: string }) => ({
          id: c.id,
          name: c.name,
          internal_id: c.internal_id,
        })));
      }
    } catch (error) {
      console.error("Customer search error:", error);
    } finally {
      setIsSearchingCustomer(false);
    }
  };

  const handleGenerateCustomProduct = () => {
    if (!selectedProductId || !customColorCode || !selectedCustomer) {
      toast({ title: "Dati incompleti", description: "Inserisci codice colore e seleziona cliente", variant: "destructive" });
      return;
    }
    generateCustomMutation.mutate({
      masterProductId: selectedProductId,
      colorCode: customColorCode,
      customerId: selectedCustomer.id,
      customerName: selectedCustomer.name,
    });
  };

  const handleProductSelect = (productId: number) => {
    setSelectedProductId(productId);
    setSelectedColorIds(new Set());
    setStep("colors");
    setDuplicateResult(null);
    setGenerateResult(null);
  };

  const handleColorToggle = (colorId: number) => {
    setSelectedColorIds((prev) => {
      const next = new Set(prev);
      if (next.has(colorId)) {
        next.delete(colorId);
      } else {
        next.add(colorId);
      }
      return next;
    });
  };

  const handleSelectAllStock = () => {
    if (!productDetails) return;
    const stockColorIds = productDetails.colors.filter((c) => c.isStock && !c.isGenerated).map((c) => c.id);
    setSelectedColorIds(new Set(stockColorIds));
  };

  const handleSelectNone = () => {
    setSelectedColorIds(new Set());
  };

  const handleCheckDuplicates = () => {
    if (!selectedProductId || selectedColorIds.size === 0) return;
    checkDuplicatesMutation.mutate({
      masterProductId: selectedProductId,
      colorIds: Array.from(selectedColorIds),
    });
  };

  const handleGenerate = () => {
    if (!selectedProductId || !duplicateResult) return;
    const colorIdsToGenerate = duplicateResult.available.map((a) => a.colorId);
    if (colorIdsToGenerate.length === 0) {
      toast({ title: "Nessun prodotto da generare", description: "Tutti i prodotti esistono già su Arke", variant: "destructive" });
      return;
    }
    generateMutation.mutate({
      masterProductId: selectedProductId,
      colorIds: colorIdsToGenerate,
    });
  };

  const handleReset = () => {
    setStep("select");
    setSelectedProductId(null);
    setSelectedColorIds(new Set());
    setDuplicateResult(null);
    setGenerateResult(null);
    setSearchFilter("");
    setStockTierFilter("all");
    setColorMode("standard");
    setCustomColorCode("");
    setCustomerSearch("");
    setSelectedCustomer(null);
    setCustomerSearchResults([]);
    setCustomColorResult(null);
  };

  const filteredProducts = masterProducts?.filter((p) => {
    const matchesSearch = p.code.toLowerCase().includes(searchFilter.toLowerCase()) ||
      p.name.toLowerCase().includes(searchFilter.toLowerCase());
    const matchesTier = stockTierFilter === "all" || p.stockTier === stockTierFilter;
    return matchesSearch && matchesTier;
  });

  const filteredColors = productDetails?.colors.filter((c) => {
    if (stockTierFilter === "stock") return c.isStock;
    if (stockTierFilter === "generated") return c.isGenerated;
    if (stockTierFilter === "available") return c.isStock && !c.isGenerated;
    return true;
  });

  const stockTiers = ["STOCK_4", "STOCK_12", "STOCK_24", "STOCK_144"];

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold" data-testid="text-page-title">Product Configurator</h1>
          <div className="flex gap-1.5 items-center">
            <Badge variant={step === "select" ? "default" : "secondary"} data-testid="badge-step-select">1. Mastro</Badge>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <Badge variant={step === "colors" ? "default" : "secondary"} data-testid="badge-step-colors">2. Colori</Badge>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <Badge variant={step === "preview" ? "default" : "secondary"} data-testid="badge-step-preview">3. Anteprima</Badge>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <Badge variant={step === "result" ? "default" : "secondary"} data-testid="badge-step-result">4. Risultato</Badge>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button 
            variant="outline" 
            onClick={() => {
              window.open("/api/configurator/color-folders/pdf", "_blank");
            }}
            data-testid="button-download-pdf"
          >
            <FileDown className="mr-2 h-4 w-4" />
            Stampa Cartella Colori
          </Button>
          <Button 
            variant="outline" 
            onClick={() => {
              window.open("/api/configurator/stock-catalog/pdf", "_blank");
            }}
            data-testid="button-download-stock-pdf"
          >
            <FileDown className="mr-2 h-4 w-4" />
            Stampa Catalogo Stock
          </Button>
          <Link href="/">
            <Button variant="outline" data-testid="button-back-home">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Home
            </Button>
          </Link>
        </div>
      </div>

      {step === "select" && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Cerca per codice o nome..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="pl-10"
                data-testid="input-search-products"
              />
            </div>
            <Select value={stockTierFilter} onValueChange={setStockTierFilter}>
              <SelectTrigger className="w-40" data-testid="select-stock-tier">
                <SelectValue placeholder="Stock Tier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tutti i tier</SelectItem>
                {stockTiers.map((tier) => (
                  <SelectItem key={tier} value={tier}>{tier}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => { resetForm(); setShowCreateDialog(true); }} data-testid="button-create-master">
              <Plus className="mr-2 h-4 w-4" />
              Nuovo Prodotto
            </Button>
          </div>

          {loadingProducts ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                {filteredProducts?.map((product) => (
                  <Card
                    key={product.id}
                    className="cursor-pointer hover-elevate transition-all"
                    onClick={() => handleProductSelect(product.id)}
                    data-testid={`card-product-${product.id}`}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm truncate" data-testid={`text-product-code-${product.id}`}>{product.code}</p>
                          <p className="text-xs text-muted-foreground truncate">{product.name}</p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Badge variant="outline" className="text-xs">{product.stockTier}</Badge>
                          <Badge variant="secondary" className="text-xs">{product.folderCode}</Badge>
                        </div>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{"\u20AC"}{product.basePrice}/{product.uom}</span>
                        <div className="flex items-center gap-1">
                          {(() => {
                            const sync = getProductSyncStatus(product.id);
                            if (sync.needsUpdate > 0 || sync.failed > 0) {
                              return (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  onClick={(e) => openSyncDialog(product.id, e)}
                                  data-testid={`button-sync-${product.id}`}
                                >
                                  <RotateCcw className="mr-1 h-3 w-3" />
                                  {sync.needsUpdate + sync.failed}
                                </Button>
                              );
                            }
                            return null;
                          })()}
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={(e) => openEditDialog(product, e)}
                            data-testid={`button-edit-${product.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}

      {step === "colors" && productDetails && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                <span className="font-bold text-lg">{productDetails.code}</span>
                <span className="text-muted-foreground text-sm">{productDetails.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Cartella: <strong>{productDetails.folderName}</strong> ({productDetails.totalColors} colori)</span>
              </div>
              <Badge variant="outline">{productDetails.stockTier}</Badge>
              <Badge variant="secondary">{productDetails.stockCount} colori in stock</Badge>
              <Badge>{productDetails.generatedCount} già generati</Badge>
            </div>
            <Button variant="outline" onClick={handleReset} data-testid="button-back">
              Torna alla selezione
            </Button>
          </div>

          <Tabs value={colorMode} onValueChange={(v) => setColorMode(v as "standard" | "custom")} className="flex-1 flex flex-col min-h-0">
            <TabsList className="mb-3 self-start">
              <TabsTrigger value="standard" data-testid="tab-standard-colors">
                <Palette className="h-4 w-4 mr-2" />
                Colori Standard
              </TabsTrigger>
              <TabsTrigger value="custom" data-testid="tab-custom-color">
                <Plus className="h-4 w-4 mr-2" />
                Colore Custom
              </TabsTrigger>
            </TabsList>

            <TabsContent value="standard" className="flex-1 flex flex-col min-h-0 mt-0">
              <div className="flex flex-wrap gap-2 mb-3 items-center">
                <Button size="sm" variant="outline" onClick={handleSelectAllStock} data-testid="button-select-stock">
                  Seleziona Stock Disponibili
                </Button>
                <Button size="sm" variant="outline" onClick={handleSelectNone} data-testid="button-select-none">
                  Deseleziona Tutti
                </Button>
                <Select value={stockTierFilter} onValueChange={setStockTierFilter}>
                  <SelectTrigger className="w-40" data-testid="select-color-filter">
                    <SelectValue placeholder="Filtra" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tutti</SelectItem>
                    <SelectItem value="stock">Solo Stock</SelectItem>
                    <SelectItem value="available">Disponibili</SelectItem>
                    <SelectItem value="generated">Già Generati</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {loadingDetails ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ScrollArea className="flex-1">
                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
                    {filteredColors?.map((color) => (
                      <div
                        key={color.id}
                        className={`relative p-3 rounded-md border text-center cursor-pointer transition-all ${
                          selectedColorIds.has(color.id)
                            ? "border-primary bg-primary/10"
                            : color.isGenerated
                            ? "border-green-500 bg-green-50 dark:bg-green-950"
                            : color.isStock
                            ? "border-blue-300 bg-blue-50 dark:bg-blue-950"
                            : "border-muted"
                        }`}
                        onClick={() => !color.isGenerated && handleColorToggle(color.id)}
                        data-testid={`color-${color.id}`}
                      >
                        {selectedColorIds.has(color.id) && (
                          <div className="absolute -top-1.5 -right-1.5 bg-primary text-primary-foreground rounded-full p-0.5">
                            <Check className="h-3.5 w-3.5" />
                          </div>
                        )}
                        {color.isGenerated && (
                          <div className="absolute -top-1.5 -right-1.5 bg-green-500 text-white rounded-full p-0.5">
                            <Check className="h-3.5 w-3.5" />
                          </div>
                        )}
                        <span className="text-sm font-mono font-medium">{color.code}</span>
                        {color.name && <span className="text-xs text-muted-foreground block truncate mt-0.5">{color.name}</span>}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t">
                <p className="text-sm text-muted-foreground">
                  Selezionati: <strong>{selectedColorIds.size}</strong> colori
                </p>
                <Button
                  onClick={handleCheckDuplicates}
                  disabled={selectedColorIds.size === 0 || checkDuplicatesMutation.isPending}
                  data-testid="button-check-duplicates"
                >
                  {checkDuplicatesMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Verifica Duplicati
                </Button>
              </div>
            </TabsContent>

              <TabsContent value="custom">
                <div className="space-y-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="custom-color-code">Codice Colore Custom</Label>
                      <Input
                        id="custom-color-code"
                        placeholder="es. 9999"
                        value={customColorCode}
                        onChange={(e) => setCustomColorCode(e.target.value)}
                        data-testid="input-custom-color-code"
                      />
                      <p className="text-xs text-muted-foreground">
                        Il codice colore richiesto dal cliente
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="customer-search">Cliente Richiedente</Label>
                      <div className="relative">
                        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                          id="customer-search"
                          placeholder="Cerca cliente..."
                          value={customerSearch}
                          onChange={(e) => {
                            setCustomerSearch(e.target.value);
                            handleSearchCustomer(e.target.value);
                          }}
                          className="pl-10"
                          data-testid="input-customer-search"
                        />
                        {isSearchingCustomer && (
                          <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
                        )}
                      </div>
                      
                      {customerSearchResults.length > 0 && !selectedCustomer && (
                        <div className="border rounded-md max-h-40 overflow-y-auto">
                          {customerSearchResults.map((customer) => (
                            <div
                              key={customer.id}
                              className="p-2 hover:bg-muted cursor-pointer text-sm"
                              onClick={() => {
                                setSelectedCustomer(customer);
                                setCustomerSearch(customer.name);
                                setCustomerSearchResults([]);
                              }}
                              data-testid={`customer-option-${customer.id}`}
                            >
                              <div className="font-medium">{customer.name}</div>
                              {customer.internal_id && (
                                <div className="text-xs text-muted-foreground">{customer.internal_id}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {selectedCustomer && (
                        <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-md">
                          <User className="h-4 w-4 text-primary" />
                          <span className="text-sm font-medium">{selectedCustomer.name}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-6 px-2"
                            onClick={() => {
                              setSelectedCustomer(null);
                              setCustomerSearch("");
                            }}
                            data-testid="button-clear-customer"
                          >
                            Cambia
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {customColorCode && selectedCustomer && (
                    <Card className="bg-muted/50">
                      <CardContent className="pt-4">
                        <h4 className="font-medium mb-2">Anteprima Prodotto</h4>
                        <div className="text-sm space-y-1">
                          <p><span className="text-muted-foreground">Codice:</span> {productDetails.code} - {customColorCode}</p>
                          <p><span className="text-muted-foreground">Nome:</span> {productDetails.code} - {customColorCode} - {productDetails.name}</p>
                          <p><span className="text-muted-foreground">Cliente:</span> {selectedCustomer.name}</p>
                          <p><span className="text-muted-foreground">Etichetta:</span> <Badge variant="secondary">custom</Badge></p>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  <div className="flex justify-end">
                    <Button
                      onClick={handleGenerateCustomProduct}
                      disabled={!customColorCode || !selectedCustomer || generateCustomMutation.isPending}
                      data-testid="button-generate-custom"
                    >
                      {generateCustomMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      <Plus className="mr-2 h-4 w-4" />
                      Genera Prodotto Custom
                    </Button>
                  </div>
                </div>
              </TabsContent>
          </Tabs>
        </div>
      )}

      {step === "preview" && duplicateResult && (
        <Card>
          <CardHeader>
            <CardTitle>Anteprima Generazione</CardTitle>
            <CardDescription>
              Prodotto: {duplicateResult.masterProduct.code} - {duplicateResult.masterProduct.name}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  Da Generare ({duplicateResult.available.length})
                </h3>
                <ScrollArea className="h-60 border rounded-md p-3">
                  {duplicateResult.available.length === 0 ? (
                    <p className="text-muted-foreground text-sm">Nessun prodotto disponibile</p>
                  ) : (
                    <div className="space-y-1">
                      {duplicateResult.available.map((item) => (
                        <div key={item.colorId} className="text-sm font-mono bg-green-50 dark:bg-green-950 p-1 rounded">
                          {item.arkeInternalId}
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>

              <div>
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-yellow-500" />
                  Duplicati Esistenti ({duplicateResult.duplicates.length})
                </h3>
                <ScrollArea className="h-60 border rounded-md p-3">
                  {duplicateResult.duplicates.length === 0 ? (
                    <p className="text-muted-foreground text-sm">Nessun duplicato</p>
                  ) : (
                    <div className="space-y-1">
                      {duplicateResult.duplicates.map((item) => (
                        <div key={item.colorId} className="text-sm font-mono bg-yellow-50 dark:bg-yellow-950 p-1 rounded">
                          {item.arkeInternalId}
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>

            <div className="mt-6 flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setStep("colors")} data-testid="button-back-colors">
                Modifica Selezione
              </Button>
              <Button
                onClick={handleGenerate}
                disabled={duplicateResult.available.length === 0 || generateMutation.isPending}
                data-testid="button-generate"
              >
                {generateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Genera {duplicateResult.available.length} Prodotti su Arke
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "result" && generateResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="h-5 w-5 text-green-500" />
              Generazione Completata
            </CardTitle>
            <CardDescription>
              {generateResult.summary.success} prodotti creati, {generateResult.summary.failed} errori
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-80 border rounded-md p-3">
              <div className="space-y-2">
                {generateResult.results.map((r, i) => (
                  <div
                    key={i}
                    className={`text-sm p-2 rounded flex items-center justify-between ${
                      r.success ? "bg-green-50 dark:bg-green-950" : "bg-red-50 dark:bg-red-950"
                    }`}
                  >
                    <span className="font-mono">{r.arkeInternalId}</span>
                    {r.success ? (
                      <Badge variant="default">Creato</Badge>
                    ) : (
                      <Badge variant="destructive">{r.error}</Badge>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="mt-6 flex gap-3 justify-end">
              <Button variant="outline" onClick={handleReset} data-testid="button-new-generation">
                <RefreshCw className="mr-2 h-4 w-4" />
                Nuova Generazione
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "result" && customColorResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="h-5 w-5 text-green-500" />
              Prodotto Custom Creato
            </CardTitle>
            <CardDescription>
              Prodotto con colore personalizzato generato su Arke
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="bg-green-50 dark:bg-green-950 p-4 rounded-md">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-lg">{customColorResult.arkeInternalId}</span>
                  <Badge variant="secondary">custom</Badge>
                </div>
                <div className="text-sm space-y-1 text-muted-foreground">
                  <p><span className="font-medium text-foreground">Cliente:</span> {customColorResult.customerName}</p>
                  <p><span className="font-medium text-foreground">ID Arke:</span> {customColorResult.arkeProductId}</p>
                  <p><span className="font-medium text-foreground">Fornitore:</span> {customColorResult.supplierAssociated ? "Associato" : "Non associato"}</p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-3 justify-end">
              <Button variant="outline" onClick={handleReset} data-testid="button-new-generation-custom">
                <RefreshCw className="mr-2 h-4 w-4" />
                Nuova Generazione
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Nuovo Prodotto Master</DialogTitle>
            <DialogDescription>Crea un nuovo prodotto base per il configuratore</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="create-code">Codice *</Label>
                <Input
                  id="create-code"
                  placeholder="es. EVO_001"
                  value={formData.code}
                  onChange={(e) => setFormData(prev => ({ ...prev, code: e.target.value }))}
                  data-testid="input-create-code"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-name">Nome *</Label>
                <Input
                  id="create-name"
                  placeholder="es. Filato Evolution"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  data-testid="input-create-name"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="create-price">Prezzo Base (EUR) *</Label>
                <Input
                  id="create-price"
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={formData.basePrice}
                  onChange={(e) => setFormData(prev => ({ ...prev, basePrice: e.target.value }))}
                  data-testid="input-create-price"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-uom">Unita di Misura</Label>
                <Select value={formData.uom} onValueChange={(v) => setFormData(prev => ({ ...prev, uom: v }))}>
                  <SelectTrigger data-testid="select-create-uom">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kilogram">Kilogrammo</SelectItem>
                    <SelectItem value="meter">Metro</SelectItem>
                    <SelectItem value="piece">Pezzo</SelectItem>
                    <SelectItem value="cone">Cono</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="create-folder">Cartella Colori *</Label>
                <Select value={formData.folderId} onValueChange={(v) => setFormData(prev => ({ ...prev, folderId: v }))}>
                  <SelectTrigger data-testid="select-create-folder">
                    <SelectValue placeholder="Seleziona cartella" />
                  </SelectTrigger>
                  <SelectContent>
                    {colorFolders?.map((folder) => (
                      <SelectItem key={folder.id} value={folder.id.toString()}>
                        {folder.code} - {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-tier">Stock Tier *</Label>
                <Select value={formData.stockTier} onValueChange={(v) => setFormData(prev => ({ ...prev, stockTier: v }))}>
                  <SelectTrigger data-testid="select-create-tier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STOCK_4">STOCK_4</SelectItem>
                    <SelectItem value="STOCK_12">STOCK_12</SelectItem>
                    <SelectItem value="STOCK_24">STOCK_24</SelectItem>
                    <SelectItem value="STOCK_144">STOCK_144</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-category">Categoria</Label>
              <Select value={formData.category} onValueChange={(v) => setFormData(prev => ({ ...prev, category: v }))}>
                <SelectTrigger data-testid="select-create-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="evolution">Evolution</SelectItem>
                  <SelectItem value="premium">Premium</SelectItem>
                  <SelectItem value="basic">Basic</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)} data-testid="button-cancel-create">
              Annulla
            </Button>
            <Button
              onClick={() => createMasterMutation.mutate(formData)}
              disabled={!formData.code || !formData.name || !formData.basePrice || !formData.folderId || createMasterMutation.isPending}
              data-testid="button-confirm-create"
            >
              {createMasterMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Crea Prodotto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={(open) => { setShowEditDialog(open); if (!open) setEditingProduct(null); }}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Modifica Prodotto Master</DialogTitle>
            <DialogDescription>
              Modifica {editingProduct?.code}. Le varianti generate verranno segnate per la sincronizzazione.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-code">Codice</Label>
                <Input
                  id="edit-code"
                  value={formData.code}
                  onChange={(e) => setFormData(prev => ({ ...prev, code: e.target.value }))}
                  data-testid="input-edit-code"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-name">Nome</Label>
                <Input
                  id="edit-name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  data-testid="input-edit-name"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-price">Prezzo Base (EUR)</Label>
                <Input
                  id="edit-price"
                  type="number"
                  step="0.01"
                  value={formData.basePrice}
                  onChange={(e) => setFormData(prev => ({ ...prev, basePrice: e.target.value }))}
                  data-testid="input-edit-price"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-uom">Unita di Misura</Label>
                <Select value={formData.uom} onValueChange={(v) => setFormData(prev => ({ ...prev, uom: v }))}>
                  <SelectTrigger data-testid="select-edit-uom">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kilogram">Kilogrammo</SelectItem>
                    <SelectItem value="meter">Metro</SelectItem>
                    <SelectItem value="piece">Pezzo</SelectItem>
                    <SelectItem value="cone">Cono</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-folder">Cartella Colori</Label>
                <Select value={formData.folderId} onValueChange={(v) => setFormData(prev => ({ ...prev, folderId: v }))}>
                  <SelectTrigger data-testid="select-edit-folder">
                    <SelectValue placeholder="Seleziona cartella" />
                  </SelectTrigger>
                  <SelectContent>
                    {colorFolders?.map((folder) => (
                      <SelectItem key={folder.id} value={folder.id.toString()}>
                        {folder.code} - {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-tier">Stock Tier</Label>
                <Select value={formData.stockTier} onValueChange={(v) => setFormData(prev => ({ ...prev, stockTier: v }))}>
                  <SelectTrigger data-testid="select-edit-tier">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STOCK_4">STOCK_4</SelectItem>
                    <SelectItem value="STOCK_12">STOCK_12</SelectItem>
                    <SelectItem value="STOCK_24">STOCK_24</SelectItem>
                    <SelectItem value="STOCK_144">STOCK_144</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-category">Categoria</Label>
              <Select value={formData.category} onValueChange={(v) => setFormData(prev => ({ ...prev, category: v }))}>
                <SelectTrigger data-testid="select-edit-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="evolution">Evolution</SelectItem>
                  <SelectItem value="premium">Premium</SelectItem>
                  <SelectItem value="basic">Basic</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowEditDialog(false); setEditingProduct(null); }} data-testid="button-cancel-edit">
              Annulla
            </Button>
            <Button
              onClick={() => editingProduct && updateMasterMutation.mutate({ id: editingProduct.id, ...formData })}
              disabled={!formData.code || !formData.name || !formData.basePrice || !formData.folderId || updateMasterMutation.isPending}
              data-testid="button-confirm-edit"
            >
              {updateMasterMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salva Modifiche
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSyncDialog} onOpenChange={(open) => { setShowSyncDialog(open); if (!open) setSyncProductId(null); }}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5" />
              Sincronizza Varianti
            </DialogTitle>
            <DialogDescription>
              {(() => {
                if (!syncProductId) return "";
                const product = masterProducts?.find(p => p.id === syncProductId);
                const sync = getProductSyncStatus(syncProductId);
                return `Aggiorna ${sync.needsUpdate + sync.failed} varianti di "${product?.code}" su Arke con prezzo e UOM aggiornati.`;
              })()}
            </DialogDescription>
          </DialogHeader>
          {syncProductId && (() => {
            const sync = getProductSyncStatus(syncProductId);
            return (
              <div className="py-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span>Varianti totali</span>
                  <Badge variant="secondary">{sync.total}</Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span>Da aggiornare</span>
                  <Badge variant="outline" className="text-yellow-600 border-yellow-400">{sync.needsUpdate}</Badge>
                </div>
                {sync.failed > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3 text-red-500" />
                      Fallite (ritentare)
                    </span>
                    <Badge variant="destructive">{sync.failed}</Badge>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm">
                  <span>Sincronizzate</span>
                  <Badge>{sync.synced}</Badge>
                </div>
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowSyncDialog(false); setSyncProductId(null); }} data-testid="button-cancel-sync">
              Annulla
            </Button>
            <Button
              onClick={() => syncProductId && syncVariantsMutation.mutate(syncProductId)}
              disabled={syncVariantsMutation.isPending}
              data-testid="button-confirm-sync"
            >
              {syncVariantsMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <RotateCcw className="mr-2 h-4 w-4" />
              Sincronizza su Arke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
