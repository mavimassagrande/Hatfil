import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { 
  Upload, 
  FileText, 
  Check, 
  X, 
  AlertCircle, 
  Loader2, 
  ArrowLeft,
  Package,
  Plus,
  Trash2,
  Edit2,
  Save,
  ArrowRight,
  Warehouse,
  Calendar,
  Hash,
  Building2,
  Euro
} from "lucide-react";
import { Link } from "wouter";

interface ExtractedProduct {
  id: string;
  originalName: string;
  masterType: string;
  variant: string;
  internalId: string;
  arkeFullName?: string;
  lotNumber: string;
  netWeight: number;
  price: number;
  uom: string;
  matched: boolean;
  productId?: string;
  rawMaterialId?: string;
  rawMaterialExternalId?: string;
  isNew: boolean;
  isEditing?: boolean;
}

interface ExtractionResult {
  invoiceNumber: string;
  invoiceDate: string;
  supplierName: string;
  supplierId?: string;
  products: ExtractedProduct[];
  totalValue: number;
}

type WizardStep = "upload" | "review";

export default function DDTInboundPage() {
  const [step, setStep] = useState<WizardStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>("");
  const { toast } = useToast();

  const { data: warehouses = [] } = useQuery<Array<{ id: string; name: string; type: string }>>({
    queryKey: ["/api/warehouses"],
  });

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === "application/pdf") {
      setFile(selectedFile);
    } else {
      toast({
        title: "Formato non valido",
        description: "Seleziona un file PDF",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.type === "application/pdf") {
      setFile(droppedFile);
    } else {
      toast({
        title: "Formato non valido",
        description: "Seleziona un file PDF",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const extractFromPDF = async () => {
    if (!file) return;

    setIsExtracting(true);
    try {
      const formData = new FormData();
      formData.append("pdf", file);

      const response = await fetch("/api/ddt-inbound/extract", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Errore durante l'estrazione");
      }

      const result = await response.json();
      setExtractionResult(result);
      setStep("review");
      toast({
        title: "Estrazione completata",
        description: `Trovati ${result.products.length} prodotti`,
      });
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile estrarre i dati dal PDF",
        variant: "destructive",
      });
    } finally {
      setIsExtracting(false);
    }
  };

  const updateProduct = (productId: string, updates: Partial<ExtractedProduct>) => {
    if (!extractionResult) return;
    
    setExtractionResult({
      ...extractionResult,
      products: extractionResult.products.map(p => 
        p.id === productId ? { ...p, ...updates } : p
      ),
    });
  };

  const removeProduct = (productId: string) => {
    if (!extractionResult) return;
    
    setExtractionResult({
      ...extractionResult,
      products: extractionResult.products.filter(p => p.id !== productId),
    });
  };

  const confirmDDTMutation = useMutation({
    mutationFn: async () => {
      if (!extractionResult || !selectedWarehouse) {
        throw new Error("Dati mancanti");
      }

      const selectedWarehouseData = warehouses.find(w => w.id === selectedWarehouse);
      
      const response = await apiRequest("POST", "/api/ddt-inbound/confirm", {
        ...extractionResult,
        warehouseId: selectedWarehouse,
        warehouseName: selectedWarehouseData?.name || "Magazzino",
      });
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "DDT creato con successo",
        description: `DDT ${data.external_id} creato in Arke`,
      });
      resetWizard();
    },
    onError: (error: Error) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile creare il DDT",
        variant: "destructive",
      });
    },
  });

  const resetWizard = () => {
    setStep("upload");
    setFile(null);
    setExtractionResult(null);
    setSelectedWarehouse("");
  };

  const matchedProducts = extractionResult?.products.filter(p => p.matched) || [];
  const newProducts = extractionResult?.products.filter(p => p.isNew) || [];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card shrink-0">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {step === "upload" ? (
              <Link href="/">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
            ) : (
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={resetWizard}
                data-testid="button-back-to-upload"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Package className="h-6 w-6 text-primary" />
              <h1 className="text-xl font-semibold">DDT Inbound - Estrattore AI</h1>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
              <div className={`flex items-center gap-1 ${step === "upload" ? "text-primary font-medium" : ""}`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                  step === "upload" ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}>
                  1
                </div>
                <span>Carica</span>
              </div>
              <ArrowRight className="h-4 w-4" />
              <div className={`flex items-center gap-1 ${step === "review" ? "text-primary font-medium" : ""}`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                  step === "review" ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}>
                  2
                </div>
                <span>Revisione</span>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {step === "upload" && (
        <main className="flex-1 flex items-center justify-center p-4">
          <Card className="w-full max-w-lg">
            <CardHeader className="text-center">
              <CardTitle className="flex items-center justify-center gap-2 text-2xl">
                <Upload className="h-7 w-7" />
                Carica Fattura PDF
              </CardTitle>
              <CardDescription className="text-base">
                Trascina o seleziona il PDF della fattura HATFIL per estrarre automaticamente i prodotti
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div
                className={`border-2 border-dashed rounded-xl p-12 text-center transition-all cursor-pointer ${
                  file 
                    ? "border-primary bg-primary/5" 
                    : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
                }`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => document.getElementById("pdf-upload")?.click()}
                data-testid="dropzone-pdf"
              >
                <input
                  id="pdf-upload"
                  type="file"
                  accept=".pdf"
                  onChange={handleFileChange}
                  className="hidden"
                  data-testid="input-pdf"
                />
                {file ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 rounded-xl bg-primary/10 flex items-center justify-center">
                      <FileText className="h-8 w-8 text-primary" />
                    </div>
                    <div>
                      <p className="font-semibold text-lg" data-testid="text-filename">{file.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {(file.size / 1024).toFixed(1)} KB
                      </p>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                      }}
                      data-testid="button-remove-file"
                    >
                      <X className="h-4 w-4 mr-1" />
                      Rimuovi
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center">
                      <Upload className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-semibold text-lg">Trascina il PDF qui</p>
                      <p className="text-sm text-muted-foreground">
                        oppure clicca per selezionare
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <Button
                className="w-full h-12 text-base"
                onClick={extractFromPDF}
                disabled={!file || isExtracting}
                data-testid="button-extract"
              >
                {isExtracting ? (
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span>Estrazione in corso...</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span>Estrai dati e continua</span>
                    <ArrowRight className="h-5 w-5" />
                  </div>
                )}
              </Button>
            </CardContent>
          </Card>
        </main>
      )}

      {step === "review" && extractionResult && (
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="border-b bg-card/50 px-4 py-3">
            <div className="container mx-auto flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-2">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Fattura:</span>
                  <span className="font-semibold" data-testid="text-invoice-number">
                    {extractionResult.invoiceNumber}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Data:</span>
                  <span className="font-semibold" data-testid="text-invoice-date">
                    {extractionResult.invoiceDate}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Fornitore:</span>
                  <span className="font-semibold" data-testid="text-supplier">
                    {extractionResult.supplierName}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Euro className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Totale:</span>
                  <span className="font-semibold" data-testid="text-total">
                    €{extractionResult.totalValue.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="secondary" className="gap-1" data-testid="badge-matched">
                  <Check className="h-3 w-3" />
                  {matchedProducts.length} trovati
                </Badge>
                <Badge variant="outline" className="gap-1 text-amber-600 border-amber-500" data-testid="badge-new">
                  <Plus className="h-3 w-3" />
                  {newProducts.length} nuovi
                </Badge>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            <div className="container mx-auto">
              {extractionResult.products.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Nessun prodotto trovato nel PDF</p>
                </div>
              ) : (
                <div className="bg-card rounded-lg border overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-muted/50 border-b">
                        <tr>
                          <th className="text-left px-4 py-3 font-medium text-sm">Stato</th>
                          <th className="text-left px-4 py-3 font-medium text-sm">Prodotto Arke</th>
                          <th className="text-left px-4 py-3 font-medium text-sm">Nome Originale</th>
                          <th className="text-right px-4 py-3 font-medium text-sm">Quantità</th>
                          <th className="text-left px-4 py-3 font-medium text-sm">Lotto</th>
                          <th className="text-right px-4 py-3 font-medium text-sm">Prezzo/kg</th>
                          <th className="text-right px-4 py-3 font-medium text-sm">Totale</th>
                          <th className="text-right px-4 py-3 font-medium text-sm w-24">Azioni</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {extractionResult.products.map((product) => (
                          <tr 
                            key={product.id} 
                            className={`${
                              product.isNew 
                                ? "bg-amber-500/5" 
                                : "bg-green-500/5"
                            }`}
                            data-testid={`product-row-${product.id}`}
                          >
                            <td className="px-4 py-3">
                              {product.isNew ? (
                                <Badge variant="outline" className="text-amber-600 border-amber-500">
                                  <Plus className="h-3 w-3 mr-1" />
                                  Nuovo
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-green-600 border-green-500">
                                  <Check className="h-3 w-3 mr-1" />
                                  Trovato
                                </Badge>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {product.isEditing ? (
                                <Input
                                  value={product.internalId}
                                  onChange={(e) => updateProduct(product.id, { internalId: e.target.value })}
                                  className="h-8"
                                  data-testid={`input-product-name-${product.id}`}
                                />
                              ) : (
                                <div>
                                  <span className="font-medium">{product.internalId}</span>
                                  {product.variant && (
                                    <Badge variant="outline" className="ml-2 text-xs">
                                      {product.variant}
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {product.isNew ? (
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <Input
                                      value={product.originalName}
                                      onChange={(e) => updateProduct(product.id, { originalName: e.target.value })}
                                      className="h-8 text-sm"
                                      placeholder="Nome prodotto"
                                      data-testid={`input-original-name-${product.id}`}
                                    />
                                  </div>
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <span>Codice: <strong>{product.internalId}</strong></span>
                                    <span>|</span>
                                    <span>Tipo: <strong>{product.masterType}</strong></span>
                                    <span>|</span>
                                    <span>Variante: <strong>{product.variant}</strong></span>
                                  </div>
                                </div>
                              ) : (
                                <span className="text-sm text-muted-foreground">{product.originalName}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {product.isEditing ? (
                                <Input
                                  type="number"
                                  value={product.netWeight}
                                  onChange={(e) => updateProduct(product.id, { netWeight: parseFloat(e.target.value) || 0 })}
                                  className="h-8 w-24 text-right"
                                  data-testid={`input-quantity-${product.id}`}
                                />
                              ) : (
                                <span className="font-medium">{product.netWeight} {product.uom}</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {product.isEditing ? (
                                <Input
                                  value={product.lotNumber}
                                  onChange={(e) => updateProduct(product.id, { lotNumber: e.target.value })}
                                  className="h-8 w-28"
                                  data-testid={`input-lot-${product.id}`}
                                />
                              ) : (
                                <span className="font-mono text-sm">{product.lotNumber}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {product.isEditing ? (
                                <Input
                                  type="number"
                                  step="0.01"
                                  value={product.price}
                                  onChange={(e) => updateProduct(product.id, { price: parseFloat(e.target.value) || 0 })}
                                  className="h-8 w-24 text-right"
                                  data-testid={`input-price-${product.id}`}
                                />
                              ) : (
                                <span>€{product.price.toFixed(2)}</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right font-medium">
                              €{(product.netWeight * product.price).toFixed(2)}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-1">
                                {product.isEditing ? (
                                  <>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => updateProduct(product.id, { isEditing: false })}
                                      data-testid={`button-cancel-edit-${product.id}`}
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      size="icon"
                                      onClick={() => updateProduct(product.id, { isEditing: false })}
                                      data-testid={`button-save-edit-${product.id}`}
                                    >
                                      <Save className="h-4 w-4" />
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => updateProduct(product.id, { isEditing: true })}
                                      data-testid={`button-edit-${product.id}`}
                                    >
                                      <Edit2 className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => removeProduct(product.id)}
                                      data-testid={`button-remove-${product.id}`}
                                    >
                                      <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t bg-card px-4 py-4 shrink-0">
            <div className="container mx-auto flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Warehouse className="h-5 w-5 text-muted-foreground" />
                <Label htmlFor="warehouse" className="text-sm font-medium whitespace-nowrap">
                  Magazzino destinazione:
                </Label>
                <select
                  id="warehouse"
                  className="px-3 py-2 border rounded-md bg-background min-w-[200px]"
                  value={selectedWarehouse}
                  onChange={(e) => setSelectedWarehouse(e.target.value)}
                  data-testid="select-warehouse"
                >
                  <option value="">Seleziona magazzino...</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-4">
                {newProducts.length > 0 && (
                  <span className="text-sm text-amber-600">
                    {newProducts.length} prodotti nuovi verranno creati
                  </span>
                )}
                <Button
                  size="lg"
                  onClick={() => confirmDDTMutation.mutate()}
                  disabled={!selectedWarehouse || confirmDDTMutation.isPending || extractionResult.products.length === 0}
                  data-testid="button-confirm-ddt"
                >
                  {confirmDDTMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creazione DDT...
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      Conferma DDT ({extractionResult.products.length} prodotti)
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
