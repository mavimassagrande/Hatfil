import { db } from "./db";
import { orderDrafts } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { addDays, addWeeks, addMonths, parse, format, isValid } from "date-fns";
import { it } from "date-fns/locale";

function parseRelativeDate(input: string): string {
  const now = new Date();
  const lowered = input.toLowerCase().trim();
  
  // Pattern: "tra X giorni/settimane/mesi"
  const traMatch = lowered.match(/tra\s+(\d+)\s+(giorn[oi]|settiman[ae]|mes[ei])/i);
  if (traMatch) {
    const num = parseInt(traMatch[1], 10);
    const unit = traMatch[2].toLowerCase();
    if (unit.startsWith("giorn")) {
      return addDays(now, num).toISOString();
    } else if (unit.startsWith("settiman")) {
      return addWeeks(now, num).toISOString();
    } else if (unit.startsWith("mes")) {
      return addMonths(now, num).toISOString();
    }
  }
  
  // Pattern: "domani"
  if (lowered === "domani") {
    return addDays(now, 1).toISOString();
  }
  
  // Pattern: "dopodomani"
  if (lowered === "dopodomani") {
    return addDays(now, 2).toISOString();
  }
  
  // Pattern: "prossima settimana"
  if (lowered.includes("prossima settimana")) {
    return addWeeks(now, 1).toISOString();
  }
  
  // Pattern: "prossimo mese"
  if (lowered.includes("prossimo mese")) {
    return addMonths(now, 1).toISOString();
  }
  
  // Pattern: date in formato YYYY-MM-DD
  const isoMatch = input.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const parsed = new Date(`${isoMatch[0]}T00:00:00.000Z`);
    if (isValid(parsed)) {
      return parsed.toISOString();
    }
  }
  
  // Pattern: date in formato DD/MM/YYYY o DD-MM-YYYY
  const euMatch = input.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (euMatch) {
    const day = parseInt(euMatch[1], 10);
    const month = parseInt(euMatch[2], 10) - 1;
    const year = parseInt(euMatch[3], 10);
    const parsed = new Date(year, month, day);
    if (isValid(parsed)) {
      return parsed.toISOString();
    }
  }
  
  // Se già ISO completo, restituiscilo
  if (input.includes("T") && input.includes("Z")) {
    const parsed = new Date(input);
    if (isValid(parsed)) {
      return parsed.toISOString();
    }
  }
  
  // Fallback: aggiungi 14 giorni di default
  console.warn(`[parseRelativeDate] Formato data non riconosciuto: "${input}", usando +14 giorni`);
  return addDays(now, 14).toISOString();
}

export interface OrderDraftProduct {
  id: string;  // UUID del prodotto dal catalogo Arke
  extra_id: string;  // Codice prodotto (internal_id)
  name: string;
  quantity: number;
  uom: string;
  prices: {
    currency: string;
    unit: number;
    vat: number;
    base_price: number;
    discount_percent: number;
  };
}

export interface CustomerData {
  id: string;
  name: string;
  address: string;
  country: string;
  vat: string;
  default_currency: string;
  addresses: Array<{ name?: string; address?: string; country?: string }>;
}

export type WizardStep = "CLIENTE" | "INDIRIZZO" | "PRODOTTI" | "CONFERMA";

export interface OrderDraftData {
  conversationId: number;
  wizardStep: WizardStep;
  customer?: CustomerData;
  products: OrderDraftProduct[];
  shipping_address?: string;
  expected_shipping_time?: string;
  notes?: string;
}

export const orderDraftService = {
  async getDraft(conversationId: number): Promise<OrderDraftData> {
    const existing = await db.select().from(orderDrafts).where(eq(orderDrafts.conversationId, conversationId)).limit(1);
    
    if (existing.length > 0) {
      const row = existing[0];
      return {
        conversationId,
        wizardStep: (row.wizardStep as WizardStep) || "CLIENTE",
        customer: row.customerData ? (row.customerData as CustomerData) : undefined,
        products: (row.products as OrderDraftProduct[]) || [],
        shipping_address: row.shippingAddress || undefined,
        expected_shipping_time: row.expectedShippingTime || undefined,
        notes: row.notes || undefined,
      };
    }
    
    await db.insert(orderDrafts).values({
      conversationId,
      wizardStep: "CLIENTE",
      products: [],
    });
    
    return {
      conversationId,
      wizardStep: "CLIENTE",
      products: [],
    };
  },

  async getWizardStep(conversationId: number): Promise<WizardStep> {
    const draft = await this.getDraft(conversationId);
    return draft.wizardStep;
  },

  async setWizardStep(conversationId: number, step: WizardStep): Promise<void> {
    await this.getDraft(conversationId);
    await db.update(orderDrafts)
      .set({ wizardStep: step, updatedAt: new Date() })
      .where(eq(orderDrafts.conversationId, conversationId));
  },

  async getStateBlock(conversationId: number): Promise<string> {
    const draft = await this.getDraft(conversationId);
    const customerDisplay = draft.customer?.name || "MANCANTE";
    const addressDisplay = draft.shipping_address || "MANCANTE";
    const productCount = draft.products.length;
    
    return `--- STATO DB ---
Cliente: ${customerDisplay}
Indirizzo: ${addressDisplay}
Articoli: ${productCount}
-----------------`;
  },

  async setCustomer(conversationId: number, customerData: {
    id: string;
    name: string;
    addresses?: Array<{ name?: string; address?: string; country?: string }>;
    vat_no?: string;
    default_currency?: string;
  }): Promise<string> {
    await this.getDraft(conversationId);
    
    const addr = customerData.addresses?.[0];
    const customer: CustomerData = {
      id: customerData.id,
      name: customerData.name,
      address: addr?.address || "",
      country: addr?.country || "",
      vat: customerData.vat_no || "n/a",
      default_currency: customerData.default_currency || "EUR",
      addresses: customerData.addresses || [],
    };
    
    await db.update(orderDrafts)
      .set({
        customerId: customerData.id,
        customerName: customerData.name,
        customerData: customer,
        wizardStep: "INDIRIZZO",
        updatedAt: new Date(),
      })
      .where(eq(orderDrafts.conversationId, conversationId));
    
    return `Cliente "${customerData.name}" salvato nel draft.\nIndirizzi disponibili:\n${
      (customerData.addresses || []).map((a, i) => `${i + 1}. ${a.address || ""} - ${a.country || ""}`).join("\n") || "Nessun indirizzo"
    }`;
  },

  async addProduct(conversationId: number, productData: {
    id: string;  // UUID del prodotto dal catalogo Arke
    internal_id: string;  // Codice prodotto
    name: string;
    quantity: number;
    uom: string;
    prices?: { currency?: string; unit?: number; vat?: number };
  }): Promise<string> {
    const draft = await this.getDraft(conversationId);
    
    const existingIndex = draft.products.findIndex(p => p.extra_id === productData.internal_id);
    if (existingIndex >= 0) {
      // SOVRASCRIVE la quantità invece di sommarla (comportamento idempotente)
      const oldQty = draft.products[existingIndex].quantity;
      draft.products[existingIndex].quantity = productData.quantity;
      draft.products[existingIndex].id = productData.id;  // Aggiorna anche l'UUID
      draft.products[existingIndex].prices = {
        currency: productData.prices?.currency || "EUR",
        unit: productData.prices?.unit || 0,
        vat: productData.prices?.vat || 0,
        base_price: productData.prices?.unit || 0,
        discount_percent: 0,
      };
      await db.update(orderDrafts)
        .set({ products: draft.products, updatedAt: new Date() })
        .where(eq(orderDrafts.conversationId, conversationId));
      return `Quantità aggiornata: ${productData.internal_id} da ${oldQty} a ${productData.quantity} ${productData.uom}`;
    }

    const newProduct: OrderDraftProduct = {
      id: productData.id,  // UUID del prodotto dal catalogo Arke
      extra_id: productData.internal_id,
      name: productData.name,
      quantity: productData.quantity,
      uom: productData.uom,
      prices: {
        currency: productData.prices?.currency || "EUR",
        unit: productData.prices?.unit || 0,
        vat: productData.prices?.vat || 0,
        base_price: productData.prices?.unit || 0,
        discount_percent: 0,
      },
    };
    
    draft.products.push(newProduct);
    await db.update(orderDrafts)
      .set({ products: draft.products, updatedAt: new Date() })
      .where(eq(orderDrafts.conversationId, conversationId));
    
    return `Prodotto aggiunto: ${productData.internal_id} x ${productData.quantity} ${productData.uom} @ €${productData.prices?.unit || 0}`;
  },

  async removeProduct(conversationId: number, internalId: string): Promise<string> {
    const draft = await this.getDraft(conversationId);
    
    // Cerca prodotto per extra_id (internal_id) - case insensitive
    const existingIndex = draft.products.findIndex(p => 
      p.extra_id === internalId || 
      p.extra_id?.toLowerCase() === internalId.toLowerCase()
    );
    
    if (existingIndex < 0) {
      return `Prodotto "${internalId}" non trovato nel carrello. Verifica il codice.`;
    }
    
    const removedProduct = draft.products[existingIndex];
    draft.products.splice(existingIndex, 1);
    
    await db.update(orderDrafts)
      .set({ products: draft.products, updatedAt: new Date() })
      .where(eq(orderDrafts.conversationId, conversationId));
    
    return `RIMOSSO DAL CARRELLO: ${removedProduct.extra_id} - ${removedProduct.name} (${removedProduct.quantity} ${removedProduct.uom})`;
  },

  async setShippingAddress(conversationId: number, address: string): Promise<string> {
    await this.getDraft(conversationId);
    
    await db.update(orderDrafts)
      .set({
        shippingAddress: address,
        wizardStep: "PRODOTTI",
        updatedAt: new Date(),
      })
      .where(eq(orderDrafts.conversationId, conversationId));
    
    return `SALVATO NEL DATABASE: Indirizzo di spedizione = "${address}"`;
  },

  async setShippingDate(conversationId: number, date: string): Promise<string> {
    await this.getDraft(conversationId);
    
    // Converti la data (relativa o assoluta) in formato ISO
    const isoDate = parseRelativeDate(date);
    const formattedDate = format(new Date(isoDate), "d MMMM yyyy", { locale: it });
    
    console.log(`[setShippingDate] Input: "${date}" -> ISO: "${isoDate}" -> Display: "${formattedDate}"`);
    
    await db.update(orderDrafts)
      .set({
        expectedShippingTime: isoDate,
        updatedAt: new Date(),
      })
      .where(eq(orderDrafts.conversationId, conversationId));
    
    return `SALVATO NEL DATABASE: Data spedizione = "${formattedDate}" (${isoDate})`;
  },

  async setShippingDetails(conversationId: number, details: {
    shipping_address: string;
    expected_shipping_time: string;
    notes?: string;
  }): Promise<string> {
    await this.getDraft(conversationId);
    
    await db.update(orderDrafts)
      .set({
        shippingAddress: details.shipping_address,
        expectedShippingTime: details.expected_shipping_time,
        notes: details.notes || null,
        updatedAt: new Date(),
      })
      .where(eq(orderDrafts.conversationId, conversationId));
    
    return `Dettagli spedizione salvati:\n- Indirizzo: ${details.shipping_address}\n- Data: ${details.expected_shipping_time}`;
  },

  async getSummary(conversationId: number): Promise<string> {
    const draft = await this.getDraft(conversationId);
    
    if (!draft.customer) {
      return "Draft vuoto. Nessun cliente selezionato.";
    }

    let summary = "RIEPILOGO ORDINE:\n";
    summary += `- Cliente: ${draft.customer.name}\n`;
    summary += `- ID Cliente: ${draft.customer.id}\n`;
    
    if (draft.shipping_address) {
      summary += `- Indirizzo spedizione: ${draft.shipping_address}\n`;
    }
    if (draft.expected_shipping_time) {
      summary += `- Data spedizione: ${draft.expected_shipping_time}\n`;
    }
    
    if (draft.products.length === 0) {
      summary += "- Prodotti: nessuno\n";
    } else {
      summary += "- Prodotti:\n";
      let total = 0;
      for (const p of draft.products) {
        const lineTotal = p.quantity * p.prices.unit;
        total += lineTotal;
        summary += `  • ${p.extra_id} x ${p.quantity} ${p.uom} @ €${p.prices.unit} = €${lineTotal}\n`;
      }
      summary += `- TOTALE: €${total}\n`;
    }

    const missing: string[] = [];
    if (!draft.shipping_address) missing.push("indirizzo spedizione");
    if (!draft.expected_shipping_time) missing.push("data spedizione");
    if (draft.products.length === 0) missing.push("prodotti");
    
    if (missing.length > 0) {
      summary += `\nMancano: ${missing.join(", ")}`;
    } else {
      summary += "\nTutti i dati sono completi. Scrivi CONFERMA per creare l'ordine.";
    }
    
    return summary;
  },

  async getContextSummary(conversationId: number): Promise<string> {
    const draft = await this.getDraft(conversationId);
    
    let context = "STATO ORDINE CORRENTE: ";
    
    if (!draft.customer && draft.products.length === 0) {
      return "STATO ORDINE CORRENTE: Vuoto. Nessun cliente né prodotto selezionato.";
    }
    
    if (draft.customer) {
      context += `Cliente: ${draft.customer.name} (ID: ${draft.customer.id}). `;
    } else {
      context += "Nessun cliente. ";
    }
    
    if (draft.products.length > 0) {
      context += `${draft.products.length} prodotto/i nel carrello. `;
      const total = draft.products.reduce((sum, p) => sum + (p.quantity * p.prices.unit), 0);
      context += `Totale: €${total}. `;
    } else {
      context += "Carrello vuoto. ";
    }
    
    if (draft.shipping_address) {
      context += `Spedizione: ${draft.shipping_address}. `;
    }
    
    return context;
  },

  async isReady(conversationId: number): Promise<{ ready: boolean; missing: string[] }> {
    const draft = await this.getDraft(conversationId);
    const missing: string[] = [];
    
    if (!draft.customer) missing.push("cliente");
    if (!draft.shipping_address) missing.push("indirizzo spedizione");
    if (!draft.expected_shipping_time) missing.push("data spedizione");
    if (draft.products.length === 0) missing.push("prodotti");
    
    return { ready: missing.length === 0, missing };
  },

  async getPayload(conversationId: number): Promise<{
    customer_id: string;
    customer_attr: { id: string; name: string; address: string; country: string; vat: string };
    default_currency: string;
    expected_shipping_time: string;
    shipping_address: string;
    products: OrderDraftProduct[];
    notes: string;
  } | null> {
    const draft = await this.getDraft(conversationId);
    
    if (!draft.customer || !draft.shipping_address || !draft.expected_shipping_time || draft.products.length === 0) {
      return null;
    }

    return {
      customer_id: draft.customer.id,
      customer_attr: {
        id: draft.customer.id,
        name: draft.customer.name,
        address: draft.customer.address,
        country: draft.customer.country,
        vat: draft.customer.vat,
      },
      default_currency: draft.customer.default_currency,
      expected_shipping_time: draft.expected_shipping_time,
      shipping_address: draft.shipping_address,
      products: draft.products,
      notes: draft.notes || "",
    };
  },

  async clear(conversationId: number): Promise<string> {
    await db.delete(orderDrafts).where(eq(orderDrafts.conversationId, conversationId));
    return "Sessione resettata. Puoi iniziare un nuovo ordine.";
  },
};
