import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { 
  Check, 
  X, 
  AlertCircle, 
  Loader2, 
  ArrowLeft,
  Package,
  ArrowRight,
  Warehouse,
  Calendar,
  Hash,
  Building2,
  Euro,
  Truck,
  FileText,
  CheckCircle2,
  RefreshCw
} from "lucide-react";
import { Link } from "wouter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface OrderProduct {
  id?: string;
  extra_id: string;
  name: string;
  quantity: number;
  uom: string;
  prices?: {
    currency: string;
    unit: number;
  };
}

interface ActiveOrder {
  id: string;
  internal_id?: string;
  name: string;
  status: string;
  expected_delivery_time?: string;
  time?: string;
  total_vat_incl?: number;
  customer_attr?: { 
    name?: string;
    address?: string;
    country?: string;
  };
  shipping_address?: string;
  products?: OrderProduct[];
}

interface OrderDetails extends ActiveOrder {
  products: OrderProduct[];
  customer_id?: string;
}

interface WarehouseInfo {
  id: string;
  name: string;
  type: string;
}

interface FulfillmentResult {
  success: boolean;
  ddt?: {
    id: string;
    internal_id?: string;
  };
  inventoryResults?: Array<{
    productId: string;
    success: boolean;
    error?: string;
    action?: string;
  }>;
  message?: string;
  error?: string;
}

interface InventoryStatus {
  productId: string;
  extra_id: string;
  availableQuantity: number;
  requiredQuantity: number;
  difference: number;
  needsAdjustment: boolean;
}

type WizardStep = "select-order" | "select-warehouse" | "confirm" | "result";

export default function TurkeyFulfillmentPage() {
  const [step, setStep] = useState<WizardStep>("select-order");
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>("");
  const [fulfillmentResult, setFulfillmentResult] = useState<FulfillmentResult | null>(null);
  const [inventoryStatus, setInventoryStatus] = useState<InventoryStatus[]>([]);
  const [isCheckingInventory, setIsCheckingInventory] = useState(false);
  const { toast } = useToast();

  const { data: orders = [], isLoading: ordersLoading, isFetching: ordersRefetching, refetch: refetchOrders } = useQuery<ActiveOrder[]>({
    queryKey: ["/api/turkey-fulfillment/orders"],
  });

  const { data: warehouses = [] } = useQuery<WarehouseInfo[]>({
    queryKey: ["/api/warehouses"],
  });

  const { data: orderDetails, isLoading: orderDetailsLoading } = useQuery<OrderDetails>({
    queryKey: ["/api/turkey-fulfillment/order", selectedOrderId],
    enabled: !!selectedOrderId && step !== "select-order",
  });

  const fulfillMutation = useMutation({
    mutationFn: async (data: {
      orderId: string;
      orderInternalId: string;
      warehouseId: string;
      warehouseName: string;
      warehouseType: string;
      shippingAddress: string;
      products: Array<{
        id: string;
        productId: string;
        extra_id: string;
        name: string;
        quantity: number;
        uom: string;
      }>;
      inventoryAdjustments?: Array<{
        productId: string;
        adjustmentQuantity: number;
      }>;
    }) => {
      const response = await apiRequest("POST", "/api/turkey-fulfillment/fulfill", data);
      return response.json();
    },
    onSuccess: (data: FulfillmentResult) => {
      setFulfillmentResult(data);
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["/api/turkey-fulfillment/orders"] });
      if (data.success) {
        toast({
          title: "Ordine evaso con successo",
          description: data.message || "DDT creato correttamente",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Errore",
        description: error.message || "Errore durante l'evasione dell'ordine",
        variant: "destructive",
      });
    },
  });

  const selectedOrder = orders.find(o => o.id === selectedOrderId);
  const selectedWarehouse = warehouses.find(w => w.id === selectedWarehouseId);

  const handleSelectOrder = useCallback((orderId: string) => {
    setSelectedOrderId(orderId);
    setStep("select-warehouse");
  }, []);

  const handleSelectWarehouse = useCallback((warehouseId: string) => {
    setSelectedWarehouseId(warehouseId);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!orderDetails || !selectedWarehouse) return;
    
    // For non-virtual warehouses, check inventory first
    if (selectedWarehouse.type !== "virtual") {
      setIsCheckingInventory(true);
      try {
        const productsToCheck = orderDetails.products.map(p => ({
          productId: p.id || "",
          extra_id: p.extra_id,
          requiredQuantity: p.quantity,
        }));
        
        const response = await apiRequest("POST", "/api/turkey-fulfillment/check-inventory", {
          warehouseId: selectedWarehouse.id,
          products: productsToCheck,
        });
        
        const data = await response.json();
        setInventoryStatus(data.inventoryStatus || []);
      } catch (error) {
        console.error("Error checking inventory:", error);
        toast({
          title: "Errore",
          description: "Impossibile verificare la giacenza",
          variant: "destructive",
        });
      } finally {
        setIsCheckingInventory(false);
      }
    } else {
      setInventoryStatus([]);
    }
    
    setStep("confirm");
  }, [orderDetails, selectedWarehouse, toast]);

  const handleFulfill = useCallback(() => {
    if (!orderDetails || !selectedWarehouse) return;

    const productsToFulfill = orderDetails.products.map(p => ({
      id: p.id || "",
      productId: p.id || "",
      extra_id: p.extra_id,
      name: p.name,
      quantity: p.quantity,
      uom: p.uom,
    }));

    // For non-virtual warehouses, include inventory adjustments
    const inventoryAdjustments = selectedWarehouse.type !== "virtual" 
      ? inventoryStatus
          .filter(s => s.needsAdjustment)
          .map(s => ({
            productId: s.productId,
            adjustmentQuantity: s.difference,
          }))
      : undefined;

    fulfillMutation.mutate({
      orderId: orderDetails.id,
      orderInternalId: orderDetails.internal_id || orderDetails.id,
      warehouseId: selectedWarehouse.id,
      warehouseName: selectedWarehouse.name,
      warehouseType: selectedWarehouse.type,
      shippingAddress: orderDetails.shipping_address || "",
      products: productsToFulfill,
      inventoryAdjustments,
    });
  }, [orderDetails, selectedWarehouse, fulfillMutation, inventoryStatus]);

  const handleReset = useCallback(() => {
    setStep("select-order");
    setSelectedOrderId("");
    setSelectedWarehouseId("");
    setFulfillmentResult(null);
    setInventoryStatus([]);
    refetchOrders();
  }, [refetchOrders]);

  const handleBack = useCallback(() => {
    if (step === "select-warehouse") {
      setStep("select-order");
      setSelectedOrderId("");
    } else if (step === "confirm") {
      setStep("select-warehouse");
    }
  }, [step]);

  const formatDate = (dateString?: string) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleDateString("it-IT");
  };

  const formatCurrency = (amount?: number) => {
    if (amount === undefined) return "-";
    return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(amount);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back-home">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Truck className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold">Evasione Rapida Ordini</h1>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="container py-6 max-w-4xl mx-auto">
        <div className="mb-6 flex items-center gap-2">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${step === "select-order" ? "bg-primary text-primary-foreground" : selectedOrderId ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
            1
          </div>
          <div className={`h-1 flex-1 ${selectedOrderId ? "bg-primary/50" : "bg-muted"}`} />
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${step === "select-warehouse" ? "bg-primary text-primary-foreground" : selectedWarehouseId ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
            2
          </div>
          <div className={`h-1 flex-1 ${step === "confirm" || step === "result" ? "bg-primary/50" : "bg-muted"}`} />
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${step === "confirm" ? "bg-primary text-primary-foreground" : step === "result" ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
            3
          </div>
          <div className={`h-1 flex-1 ${step === "result" ? "bg-primary/50" : "bg-muted"}`} />
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${step === "result" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
            4
          </div>
        </div>

        {step === "select-order" && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Package className="h-5 w-5" />
                    Seleziona Ordine
                  </CardTitle>
                  <CardDescription>
                    Scegli l'ordine da evadere dalla Turchia
                  </CardDescription>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => refetchOrders()} 
                  disabled={ordersRefetching}
                  data-testid="button-refresh-orders"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${ordersRefetching ? 'animate-spin' : ''}`} />
                  Aggiorna
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {ordersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : orders.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <AlertCircle className="h-12 w-12 mb-4" />
                  <p>Nessun ordine attivo da evadere</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {orders.map((order) => (
                    <div
                      key={order.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover-elevate cursor-pointer"
                      onClick={() => handleSelectOrder(order.id)}
                      data-testid={`order-card-${order.id}`}
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="font-semibold" data-testid={`order-id-${order.id}`}>
                            {order.internal_id || order.id.slice(0, 8)}
                          </span>
                          <Badge variant={order.status === "accepted" ? "default" : "secondary"}>
                            {order.status}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Building2 className="h-3 w-3" />
                            <span>{order.customer_attr?.name || "-"}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            <span>{formatDate(order.expected_delivery_time || order.time)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Euro className="h-3 w-3" />
                            <span>{formatCurrency(order.total_vat_incl)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Package className="h-3 w-3" />
                            <span>{order.products?.length || 0} prodotti</span>
                          </div>
                        </div>
                      </div>
                      <ArrowRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {step === "select-warehouse" && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back-step">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Warehouse className="h-5 w-5" />
                    Seleziona Magazzino
                  </CardTitle>
                  <CardDescription>
                    Ordine: {selectedOrder?.internal_id || selectedOrder?.id.slice(0, 8)} - {selectedOrder?.customer_attr?.name}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {orderDetailsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : orderDetails && (
                <div className="p-4 bg-muted/50 rounded-lg">
                  <h3 className="font-medium mb-3">Prodotti nell'ordine:</h3>
                  <div className="space-y-2">
                    {orderDetails.products?.map((product, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm">
                        <span>{product.name}</span>
                        <span className="text-muted-foreground">
                          {product.quantity} {product.uom}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">Magazzino di spedizione:</label>
                <Select value={selectedWarehouseId} onValueChange={handleSelectWarehouse}>
                  <SelectTrigger data-testid="select-warehouse">
                    <SelectValue placeholder="Seleziona magazzino..." />
                  </SelectTrigger>
                  <SelectContent>
                    {warehouses.map((warehouse) => (
                      <SelectItem key={warehouse.id} value={warehouse.id} data-testid={`warehouse-option-${warehouse.id}`}>
                        {warehouse.name} ({warehouse.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex justify-end">
                <Button 
                  onClick={handleConfirm} 
                  disabled={!selectedWarehouseId}
                  data-testid="button-next-confirm"
                >
                  Continua
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === "confirm" && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back-step">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Conferma Evasione
                  </CardTitle>
                  <CardDescription>
                    Verifica i dati e conferma per creare il DDT
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <h3 className="font-medium flex items-center gap-2">
                    <Package className="h-4 w-4" />
                    Dettagli Ordine
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">ID Ordine:</span>
                      <span className="font-medium" data-testid="text-order-id">{orderDetails?.internal_id || orderDetails?.id}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cliente:</span>
                      <span>{orderDetails?.customer_attr?.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Indirizzo spedizione:</span>
                      <span className="text-right max-w-48">{orderDetails?.shipping_address || "-"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Totale:</span>
                      <span>{formatCurrency(orderDetails?.total_vat_incl)}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="font-medium flex items-center gap-2">
                    <Warehouse className="h-4 w-4" />
                    Magazzino Selezionato
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Nome:</span>
                      <span className="font-medium" data-testid="text-warehouse-name">{selectedWarehouse?.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tipo:</span>
                      <span>{selectedWarehouse?.type}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="font-medium">Prodotti da evadere:</h3>
                {isCheckingInventory ? (
                  <div className="flex items-center justify-center p-8">
                    <Loader2 className="h-6 w-6 animate-spin mr-2" />
                    <span>Verifica giacenza in corso...</span>
                  </div>
                ) : selectedWarehouse?.type !== "virtual" && inventoryStatus.length > 0 ? (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-muted/50">
                        <tr className="text-sm">
                          <th className="text-left p-3">Prodotto</th>
                          <th className="text-right p-3">Richiesto</th>
                          <th className="text-right p-3">Disponibile</th>
                          <th className="text-right p-3">Rettifica</th>
                          <th className="text-center p-3">Stato</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {orderDetails?.products?.map((product, idx) => {
                          const status = inventoryStatus.find(s => s.extra_id === product.extra_id);
                          return (
                            <tr key={idx} className={status?.needsAdjustment ? "bg-amber-50 dark:bg-amber-950/20" : ""}>
                              <td className="p-3">
                                <span className="font-medium">{product.name}</span>
                                <span className="text-sm text-muted-foreground ml-2">({product.extra_id})</span>
                              </td>
                              <td className="p-3 text-right font-medium">
                                {product.quantity} {product.uom}
                              </td>
                              <td className="p-3 text-right">
                                {status?.availableQuantity ?? "-"} {product.uom}
                              </td>
                              <td className="p-3 text-right">
                                {status?.needsAdjustment ? (
                                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                                    +{status.difference} {product.uom}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </td>
                              <td className="p-3 text-center">
                                {status?.needsAdjustment ? (
                                  <Badge variant="outline" className="text-amber-600 border-amber-500">
                                    Rettifica
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="text-green-600 border-green-500">
                                    <Check className="h-3 w-3 mr-1" />
                                    OK
                                  </Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="border rounded-lg divide-y">
                    {orderDetails?.products?.map((product, idx) => (
                      <div key={idx} className="flex items-center justify-between p-3">
                        <div>
                          <span className="font-medium">{product.name}</span>
                          <span className="text-sm text-muted-foreground ml-2">({product.extra_id})</span>
                        </div>
                        <Badge variant="outline">
                          {product.quantity} {product.uom}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-500 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-amber-800 dark:text-amber-400">Attenzione</p>
                    {selectedWarehouse?.type === "virtual" ? (
                      <p className="text-amber-700 dark:text-amber-500">
                        Questa operazione caricherà automaticamente la giacenza nel magazzino selezionato 
                        con le quantità esatte dell'ordine e creerà un DDT in stato bozza.
                      </p>
                    ) : (
                      <p className="text-amber-700 dark:text-amber-500">
                        Questa operazione rettificherà la giacenza (se necessario) e scaricherà le quantità 
                        dal magazzino selezionato, creando un DDT in stato bozza.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <Button variant="outline" onClick={handleBack} data-testid="button-cancel">
                  Annulla
                </Button>
                <Button 
                  onClick={handleFulfill} 
                  disabled={fulfillMutation.isPending}
                  data-testid="button-fulfill"
                >
                  {fulfillMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Elaborazione...
                    </>
                  ) : (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      Conferma Evasione
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === "result" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {fulfillmentResult?.success ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                ) : (
                  <X className="h-5 w-5 text-red-600" />
                )}
                {fulfillmentResult?.success ? "Evasione Completata" : "Errore"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {fulfillmentResult?.success ? (
                <>
                  <div className="p-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-lg">
                    <p className="text-green-800 dark:text-green-400" data-testid="text-success-message">
                      {fulfillmentResult.message}
                    </p>
                  </div>

                  {fulfillmentResult.ddt && (
                    <div className="space-y-2">
                      <h3 className="font-medium">DDT Creato:</h3>
                      <div className="p-4 border rounded-lg space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">ID DDT:</span>
                          <span className="font-medium" data-testid="text-ddt-id">
                            {fulfillmentResult.ddt.internal_id || fulfillmentResult.ddt.id}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {fulfillmentResult.inventoryResults && fulfillmentResult.inventoryResults.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="font-medium">Giacenza Caricata:</h3>
                      <div className="space-y-1">
                        {fulfillmentResult.inventoryResults.map((result, idx) => (
                          <div key={idx} className="flex items-center gap-2 text-sm">
                            {result.success ? (
                              <Check className="h-4 w-4 text-green-600" />
                            ) : (
                              <X className="h-4 w-4 text-red-600" />
                            )}
                            <span>{result.productId}</span>
                            {result.error && (
                              <span className="text-red-600">({result.error})</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg">
                  <p className="text-red-800 dark:text-red-400">
                    {fulfillmentResult?.error || "Si è verificato un errore durante l'evasione"}
                  </p>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={handleReset} data-testid="button-new-fulfillment">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Nuova Evasione
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
