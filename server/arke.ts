import axios, { AxiosError } from "axios";
import { randomUUID } from "crypto";
import { getArkeToken } from "./request-context";

export interface ArkeApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ArkeLoginResponse {
  accessToken: string;
  user: {
    sub: string;
    exp: number;
    iat: number;
    full_name: string;
    username: string;
    tenant: {
      tenant_id: string;
      tenant_url: string;
    };
    super_admin: boolean;
    roles: string[];
  };
}

function getAuthToken(): string {
  const sessionToken = getArkeToken();
  if (sessionToken) {
    return sessionToken;
  }
  return process.env.ARKE_API_TOKEN || "";
}

async function makeRequest<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  data?: unknown
): Promise<ArkeApiResponse<T>> {
  try {
    const response = await axios.request<T>({
      method,
      url: `${process.env.ARKE_BASE_URL}${path}`,
      data,
      headers: {
        "Authorization": `Bearer ${getAuthToken()}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });
    return { success: true, data: response.data };
  } catch (error) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const message = axiosError.response?.data
      ? JSON.stringify(axiosError.response.data)
      : axiosError.message;
    console.error(`Arke API error [${method} ${path}]: ${status} - ${message}`);
    return { success: false, error: `${status || "Network"} - ${message}` };
  }
}

export async function arkeLogin(username: string, password: string): Promise<ArkeLoginResponse> {
  const response = await axios.post<ArkeLoginResponse>(
    `${process.env.ARKE_BASE_URL}/login`,
    { username, password },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    }
  );
  return response.data;
}

export const arkeService = {
  // ==================== PRODUCTS ====================
  async listProducts(params?: { limit?: number; offset?: number; search?: string; category?: string }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    if (params?.search) queryParams.set("search", params.search);
    if (params?.category) queryParams.set("category", params.category);
    const query = queryParams.toString();
    return makeRequest("GET", `/product/product${query ? `?${query}` : ""}`);
  },

  async getProduct(productId: string) {
    return makeRequest("GET", `/product/product/${productId}`);
  },

  async createProduct(data: {
    name: string;
    type: "producible" | "purchasable" | "bundle";
    uom: string;
    categories?: string[];
    description?: string;
    internal_id?: string;
    master_type?: string;
    prices?: { 
      currency: string; 
      unit: number; 
      vat?: number;
      deals?: { min_quantity: number; unit: number; category: string }[];
    };
    custom_form_values?: {
      generation?: number;
      values?: { index: number; label: string; name: string; type: string; value: unknown }[] | null;
    };
  }) {
    const payload = {
      ...data,
      version: 0,
      attributes: {},
      description: data.description || "",
      categories: data.categories || [],
    };
    return makeRequest("PUT", "/product/product", payload);
  },

  async updateProduct(productId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/product/product/${productId}`, data);
  },

  async archiveProduct(productId: string) {
    return makeRequest("DELETE", `/product/product/${productId}`);
  },

  async listProductCategories() {
    return makeRequest("GET", "/product/product/_categories");
  },

  async listProductAttributes() {
    return makeRequest("GET", "/product/product/_attributes");
  },

  // ==================== PRODUCT SUPPLIERS ====================
  async getProductSuppliers(productId: string) {
    return makeRequest("GET", `/product/product/${productId}/supplier`);
  },

  async getProductSupplier(productId: string, supplierId: string) {
    return makeRequest("GET", `/product/product/${productId}/supplier/${supplierId}`);
  },

  async createProductSupplier(productId: string, data: {
    supplier_id: string;
    external_id: string;
    minimum_quantity: number;
    prices?: {
      currency: "EUR" | "USD" | "GBP";
      unit: number;
      vat?: number;
    };
    lead_time?: string;
    uom?: string;
  }) {
    const payload = {
      ...data,
      version: 0,
    };
    return makeRequest("PUT", `/product/product/${productId}/supplier`, payload);
  },

  async updateProductSupplier(productId: string, supplierId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/product/product/${productId}/supplier/${supplierId}`, data);
  },

  // ==================== INVENTORY ====================
  async listProductInventory(productId: string) {
    return makeRequest("GET", `/product/product/${productId}/inventory`);
  },

  async listInventoryItems(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    const query = queryParams.toString();
    return makeRequest("GET", `/product/inventory/product${query ? `?${query}` : ""}`);
  },

  async fetchAllInventoryItems(): Promise<any[]> {
    const pageSize = 500;
    let offset = 0;
    let allItems: any[] = [];
    while (true) {
      const result = await this.listInventoryItems({ limit: pageSize, offset });
      if (!result.success) throw new Error(result.error || "Failed to fetch inventory");
      const items = Array.isArray(result.data) ? result.data : [];
      if (items.length === 0) break;
      allItems = allItems.concat(items);
      if (items.length < pageSize) break;
      offset += pageSize;
    }
    return allItems;
  },

  async adjustInventory(productId: string, adjustment: {
    bucket: string;
    quantity: number;
    reason: string;
    warehouse_id: string;
    warehouse_attr: { id: string; name: string };
  }) {
    console.log(`[adjustInventory] Calling API for productId: ${productId}`);
    console.log(`[adjustInventory] Adjustment payload:`, JSON.stringify(adjustment, null, 2));
    const result = await makeRequest("POST", `/product/product/${productId}/inventory/_adjust`, adjustment);
    console.log(`[adjustInventory] Result:`, JSON.stringify(result, null, 2));
    return result;
  },

  async listInventoryEvents(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    const query = queryParams.toString();
    return makeRequest("GET", `/product/inventory/product/event${query ? `?${query}` : ""}`);
  },

  // ==================== WAREHOUSES ====================
  async listWarehouses() {
    return makeRequest("GET", `/iam/warehouse`);
  },

  async getWarehouse(warehouseId: string) {
    return makeRequest("GET", `/iam/warehouse/${warehouseId}`);
  },

  async getProductionFacility() {
    return makeRequest("GET", `/iam/warehouse/_production_facility`);
  },

  // ==================== CUSTOMERS ====================
  async listCustomers(params?: { limit?: number; offset?: number; search?: string }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    if (params?.search) queryParams.set("search", params.search);
    const query = queryParams.toString();
    return makeRequest("GET", `/sales/customer${query ? `?${query}` : ""}`);
  },

  async getCustomer(customerId: string) {
    return makeRequest("GET", `/sales/customer/${customerId}`);
  },

  async createCustomer(data: {
    name: string;
    vat_no: string;
    default_currency?: string;
    emails?: { name: string; email: string }[];
    phones?: { name: string; phone: string }[];
    addresses?: { name: string; address: string; country: string }[];
    categories?: string[];
  }) {
    return makeRequest("PUT", "/sales/customer", data);
  },

  async updateCustomer(customerId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/sales/customer/${customerId}`, data);
  },

  async archiveCustomer(customerId: string) {
    return makeRequest("DELETE", `/sales/customer/${customerId}`);
  },

  // ==================== SALES ORDERS ====================
  async listSalesOrders(params?: { limit?: number; offset?: number; status?: string; customer_id?: string; search?: string }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    if (params?.status) queryParams.set("status", params.status);
    if (params?.customer_id) queryParams.set("customer_id", params.customer_id);
    if (params?.search) queryParams.set("search", params.search);
    const query = queryParams.toString();
    return makeRequest("GET", `/sales/order${query ? `?${query}` : ""}`);
  },

  async getSalesOrder(orderId: string) {
    return makeRequest("GET", `/sales/order/${orderId}`);
  },

  async getLastTwoMonthSales() {
    return makeRequest("GET", `/sales/order/_last_two_month_sales`);
  },

  async listActiveOrders(params?: { limit?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    const query = queryParams.toString();
    return makeRequest("GET", `/sales/order/_active${query ? `?${query}` : ""}`);
  },

  async createSalesOrder(data: {
    customer_id: string;
    customer_attr?: { id?: string; name: string; address?: string; country?: string; vat?: string };
    expected_shipping_time: string;
    shipping_address: string;
    products: { 
      id: string;  // UUID del prodotto dal catalogo Arke
      extra_id: string;  // Product code (internal_id)
      name: string; 
      quantity: number; 
      uom: string; 
      prices?: { currency: string; unit: number; vat?: number; base_price?: number; discount_percent?: number } 
    }[];
    status?: "draft" | "accepted" | "sent";
    notes?: string;
    default_currency?: string;
  }) {
    // VALIDATION: Detect potentially invented products
    for (const p of data.products) {
      // Check for empty or generic product codes
      if (!p.extra_id || p.extra_id.trim() === "") {
        return { success: false, error: "ERRORE: Prodotto senza codice (extra_id). Cerca il prodotto nel catalogo con list_products prima di creare l'ordine." };
      }
      // Check for missing product name
      if (!p.name || p.name.trim() === "") {
        return { success: false, error: `ERRORE: Prodotto "${p.extra_id}" senza nome. Cerca il prodotto nel catalogo con list_products e usa il nome esatto.` };
      }
      // Note: prices can be 0 in Arke, so we only check if prices object exists
      // Zero-price orders are valid in Arke
      // Check for missing UOM
      if (!p.uom || p.uom.trim() === "") {
        return { success: false, error: `ERRORE: Prodotto "${p.extra_id}" senza unità di misura. Cerca il prodotto nel catalogo con list_products.` };
      }
    }
    
    // VALIDATION: Customer data
    if (!data.customer_id || data.customer_id.trim() === "") {
      return { success: false, error: "ERRORE: customer_id mancante. Cerca il cliente con list_customers prima di creare l'ordine." };
    }
    if (!data.customer_attr || !data.customer_attr.name) {
      return { success: false, error: "ERRORE: customer_attr mancante. Usa get_customer per ottenere i dati completi del cliente." };
    }
    
    // Ensure all products have complete prices with currency, base_price, discount_percent
    // id = UUID del prodotto dal catalogo Arke (obbligatorio per collegamento)
    const productsWithPrices = data.products.map(p => ({
      id: p.id,  // UUID del prodotto dal catalogo Arke
      extra_id: p.extra_id,  // Product code (internal_id like "PARSLEY 12 - PANEL")
      name: p.name,
      quantity: p.quantity,
      uom: p.uom,
      prices: {
        currency: p.prices?.currency || "EUR",
        unit: p.prices?.unit || 0,
        vat: p.prices?.vat || 0,
        base_price: p.prices?.base_price ?? p.prices?.unit ?? 0,
        discount_percent: p.prices?.discount_percent ?? 0,
      }
    }));
    const total = productsWithPrices.reduce((sum, p) => sum + (p.prices.unit * p.quantity), 0);
    const orderData = {
      customer_id: data.customer_id,
      customer_attr: data.customer_attr || { id: data.customer_id, name: "", address: "", country: "", vat: "" },
      default_currency: data.default_currency || "EUR",
      time: new Date().toISOString(),
      expected_shipping_time: data.expected_shipping_time,
      shipping_address: data.shipping_address,
      products: productsWithPrices,
      status: data.status || "draft",
      notes: data.notes || "",
      version: 1,
      total: total,
      total_vat_incl: total,
      priority: 3,
    };
    return makeRequest("PUT", "/sales/order", orderData);
  },

  async updateSalesOrder(orderId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/sales/order/${orderId}`, data);
  },

  async archiveSalesOrder(orderId: string) {
    return makeRequest("DELETE", `/sales/order/${orderId}`);
  },

  // ==================== SUPPLY ORDERS ====================
  async listSupplyOrders(params?: { limit?: number; offset?: number; status?: string }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    if (params?.status) queryParams.set("status", params.status);
    const query = queryParams.toString();
    return makeRequest("GET", `/supply/order${query ? `?${query}` : ""}`);
  },

  async getSupplyOrder(orderId: string) {
    return makeRequest("GET", `/supply/order/${orderId}`);
  },

  async createSupplyOrder(data: {
    supplier_id: string;
    expected_delivery_time: string;
    warehouse_id: string;
    products: { extra_id: string; name: string; quantity: number; uom: string; prices?: { currency: string; unit: number } }[];
    status?: "draft" | "accepted";
    notes?: string;
  }) {
    return makeRequest("PUT", "/supply/order", data);
  },

  async updateSupplyOrder(orderId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/supply/order/${orderId}`, data);
  },

  async archiveSupplyOrder(orderId: string) {
    return makeRequest("DELETE", `/supply/order/${orderId}`);
  },

  // ==================== SUPPLIERS ====================
  async listSuppliers(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    const query = queryParams.toString();
    return makeRequest("GET", `/supply/supplier${query ? `?${query}` : ""}`);
  },

  async getSupplier(supplierId: string) {
    return makeRequest("GET", `/supply/supplier/${supplierId}`);
  },

  async createSupplier(data: {
    name: string;
    vat_no: string;
    default_currency?: string;
    emails?: { name: string; email: string }[];
    phones?: { name: string; phone: string }[];
    categories?: string[];
    mode?: "ordinary" | "subcontractor";
  }) {
    return makeRequest("PUT", "/supply/supplier", data);
  },

  async updateSupplier(supplierId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/supply/supplier/${supplierId}`, data);
  },

  async archiveSupplier(supplierId: string) {
    return makeRequest("DELETE", `/supply/supplier/${supplierId}`);
  },

  // ==================== RAW MATERIALS ====================
  async listRawMaterials(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    const query = queryParams.toString();
    return makeRequest("GET", `/supply/raw-material${query ? `?${query}` : ""}`);
  },

  async getRawMaterial(rawMaterialId: string) {
    return makeRequest("GET", `/supply/raw-material/${rawMaterialId}`);
  },

  async createRawMaterial(data: {
    name: string;
    external_id: string;
    supplier_id: string;
    uom: string;
    minimum_quantity: number;
    categories?: string[];
    prices?: { currency: string; unit: number };
  }) {
    return makeRequest("PUT", "/supply/raw-material", data);
  },

  async updateRawMaterial(rawMaterialId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/supply/raw-material/${rawMaterialId}`, data);
  },

  async archiveRawMaterial(rawMaterialId: string) {
    return makeRequest("DELETE", `/supply/raw-material/${rawMaterialId}`);
  },

  async createWarehouse(data: {
    name: string;
    type: "production_facility" | "distribution_center" | "stock_at_subcontractor" | "virtual";
    address: { name: string; address: string; country: string };
    active?: boolean;
  }) {
    return makeRequest("PUT", "/iam/warehouse", data);
  },

  async updateWarehouse(warehouseId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/iam/warehouse/${warehouseId}`, data);
  },

  // ==================== PRODUCTION ====================
  async listProductionPhases() {
    return makeRequest("GET", "/product/production-phase");
  },

  async listProductionItems(params?: { limit?: number; offset?: number; status?: string }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    if (params?.status) queryParams.set("status", params.status);
    const query = queryParams.toString();
    return makeRequest("GET", `/product/production${query ? `?${query}` : ""}`);
  },

  // ==================== SALES CHANNELS ====================
  async listSalesChannels() {
    return makeRequest("GET", "/sales/sales-channel");
  },

  // ==================== OFFERS ====================
  async listCustomerOffers(customerId: string) {
    return makeRequest("GET", `/sales/customer/${customerId}/offer`);
  },

  async getOffer(customerId: string, offerId: string) {
    return makeRequest("GET", `/sales/customer/${customerId}/offer/${offerId}`);
  },

  async createOffer(customerId: string, data: {
    name: string;
    validity_start: string;
    validity_end: string;
    products: { extra_id: string; name: string; quantity: number; uom: string; prices?: { currency: string; unit: number } }[];
  }) {
    return makeRequest("PUT", `/sales/customer/${customerId}/offer`, data);
  },

  async updateOffer(customerId: string, offerId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/sales/customer/${customerId}/offer/${offerId}`, data);
  },

  // ==================== TRANSPORT DOCUMENTS (SALES - OUTBOUND) ====================
  async listTransportDocuments(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    const query = queryParams.toString();
    return makeRequest("GET", `/sales/transport-document${query ? `?${query}` : ""}`);
  },

  async getTransportDocument(documentId: string) {
    return makeRequest("GET", `/sales/transport-document/${documentId}`);
  },

  async createSalesTransportDocument(data: {
    order_id: string;
    order_internal_id: string;
    status: "draft" | "accepted" | "sent";
    warehouse_id: string;
    warehouse_attr?: { id: string; name: string; supplier_id?: string };
    shipping_address: string;
    time?: string;
    weight?: number;
    carrier?: string;
    reason?: string;
    products: {
      id?: string;
      extra_id: string;
      name: string;
      quantity: number;
      uom: string;
      external_lot?: string;
      lot?: string;
      item_id?: string;
      order_id?: string;
    }[];
  }) {
    const payload = {
      ...data,
      version: 0,
      time: data.time || new Date().toISOString(),
    };
    return makeRequest("PUT", "/sales/transport-document", payload);
  },

  async acceptSalesTransportDocument(documentId: string) {
    return makeRequest("POST", `/sales/transport-document/${documentId}/_accept`);
  },

  // ==================== TRANSPORT DOCUMENTS (SUPPLY - INBOUND) ====================
  async listInboundTransportDocuments(params?: { limit?: number; offset?: number }) {
    const queryParams = new URLSearchParams();
    if (params?.limit) queryParams.set("limit", params.limit.toString());
    if (params?.offset) queryParams.set("offset", params.offset.toString());
    const query = queryParams.toString();
    return makeRequest("GET", `/supply/transport-document${query ? `?${query}` : ""}`);
  },

  async getInboundTransportDocument(documentId: string) {
    return makeRequest("GET", `/supply/transport-document/${documentId}`);
  },

  async createInboundTransportDocument(data: {
    external_id: string;
    status: "inbound" | "accepted";
    warehouse_id: string;
    warehouse_attr?: { id: string; name: string; supplier_id?: string };
    supplier_id?: string;
    supplier_attr?: { id?: string; name: string; vat: string; address?: string; country?: string };
    time?: string;
    weight?: number;
    raw_materials: {
      id?: string;
      extra_id: string;
      name: string;
      quantity: number;
      uom: string;
      external_lot?: string;
      lot?: string;
      item_id?: string;
      order_id?: string;
      prices?: { currency: "EUR" | "USD" | "GBP"; unit: number; vat?: number };
    }[];
  }) {
    const payload = {
      ...data,
      version: 0,
      time: data.time || new Date().toISOString(),
    };
    return makeRequest("PUT", "/supply/transport-document", payload);
  },

  async updateInboundTransportDocument(documentId: string, data: Record<string, unknown>) {
    return makeRequest("PUT", `/supply/transport-document/${documentId}`, data);
  },

  async acceptInboundTransportDocument(documentId: string) {
    return makeRequest("POST", `/supply/transport-document/${documentId}/_accept`);
  },

  // ==================== RAW MATERIALS BY SUPPLIER ====================
  async listRawMaterialsBySupplier(supplierId: string) {
    return makeRequest("GET", `/supply/supplier/${supplierId}/raw-material`);
  },
};

export function formatArkeDataAsTable(data: unknown): string {
  if (!data) return "Nessun dato trovato.";
  
  if (Array.isArray(data)) {
    if (data.length === 0) return "Nessun risultato trovato.";
    
    const headers = Object.keys(data[0]);
    // IMPORTANT: Always include 'id' first if present, then other relevant fields
    const hasId = headers.includes("id");
    let relevantHeaders = headers.filter(h => 
      h !== "id" &&  // Exclude id here, we'll add it first
      !h.includes("_attr") && 
      !h.startsWith("foreign_") &&
      !h.startsWith("custom_form") &&
      !h.startsWith("version")
    ).slice(0, 7);
    
    // Put 'id' first if present
    if (hasId) {
      relevantHeaders = ["id", ...relevantHeaders];
    }
    
    let table = "| " + relevantHeaders.join(" | ") + " |\n";
    table += "| " + relevantHeaders.map(() => "---").join(" | ") + " |\n";
    
    for (const row of data.slice(0, 50)) {
      const values = relevantHeaders.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return "-";
        if (typeof val === "object") return JSON.stringify(val).slice(0, 30);
        return String(val).slice(0, 40);
      });
      table += "| " + values.join(" | ") + " |\n";
    }
    
    if (data.length > 50) {
      table += `\n*...e altri ${data.length - 50} risultati*`;
    }
    
    return table;
  }
  
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    let result = "";
    for (const [key, value] of Object.entries(obj)) {
      if (key.includes("_attr") || key.startsWith("foreign_") || key.startsWith("custom_form") || key === "version") continue;
      if (typeof value === "object" && value !== null) {
        result += `**${key}**: ${JSON.stringify(value, null, 2)}\n`;
      } else {
        result += `**${key}**: ${value}\n`;
      }
    }
    return result || "Dati non disponibili.";
  }
  
  return String(data);
}
